import { randomBytes } from 'node:crypto'
import type { HttpResult, RequestContext, Router } from '../http.js'
import { ingestApiSend, toAddress, toAddressList } from '../mime.js'
import { sendgridSignature } from '../signing.js'
import type { StoredEmail } from '../types.js'
import { attachment, headerRecord, recipient, str, unixSeconds } from './common.js'
import type { Hub, ProviderModule } from './types.js'

const EVENT_NAMES = {
  delivered: 'delivered',
  bounced: 'bounce',
  complained: 'spamreport',
  opened: 'open',
  clicked: 'click',
} as const

function error(status: number, message: string, field: string | null = null, help: string | null = null): HttpResult {
  return { status, body: { errors: [{ message, field, help }] } }
}

type Personalization = {
  to?: unknown
  cc?: unknown
  bcc?: unknown
  subject?: string
  headers?: Record<string, string>
  substitutions?: Record<string, string>
  dynamic_template_data?: Record<string, unknown>
  custom_args?: Record<string, string>
}

function substitute(value: string | undefined, subs: Record<string, string> | undefined): string | undefined {
  if (!value || !subs) return value
  let out = value
  for (const [key, replacement] of Object.entries(subs)) out = out.split(key).join(String(replacement))
  return out
}

async function sendgridSend(ctx: RequestContext, hub: Hub): Promise<HttpResult | void> {
  if (await hub.guard(ctx, sendgrid)) return
  const body = await ctx.json<Record<string, unknown>>()
  const personalizations = (Array.isArray(body.personalizations) ? body.personalizations : []) as Personalization[]
  if (!personalizations.length) {
    return error(400, 'The personalizations field is required and must have at least one personalization.', 'personalizations', 'http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#-Personalizations-Errors')
  }
  const from = toAddress(body.from as never)
  if (!from) return error(400, 'The from object must be provided for every email send. It is an object that requires the email parameter, but may also contain a name parameter.', 'from.email')
  const content = (Array.isArray(body.content) ? body.content : []) as Array<{ type?: string; value?: string }>
  const templateId = str(body.template_id)
  const baseHtml = content.find((c) => c.type === 'text/html')?.value
  const baseText = content.find((c) => c.type === 'text/plain')?.value
  const attachments = Array.isArray(body.attachments)
    ? (body.attachments as Array<Record<string, unknown>>).map((a) => attachment(a.filename, a.content, a.type, a.content_id))
    : undefined
  const categories = Array.isArray(body.categories) ? (body.categories as string[]) : []
  const xMessageId = randomBytes(16).toString('base64url').slice(0, 22)
  const caught: StoredEmail[] = []
  for (const [index, p] of personalizations.entries()) {
    const to = toAddressList(p.to)
    if (!to.length) return error(400, 'The to array is required for all personalization objects, and must have at least one email object with a valid email address.', `personalizations.${index}.to`)
    let html = substitute(baseHtml, p.substitutions)
    let text = substitute(baseText, p.substitutions)
    if (!html && !text && templateId) {
      text = `Sent with SendGrid dynamic template ${templateId}. Groundhog can't render stored templates; the data it was sent with:\n\n${JSON.stringify(p.dynamic_template_data ?? {}, null, 2)}`
    }
    const customArgs = { ...((body.custom_args as Record<string, string>) ?? {}), ...(p.custom_args ?? {}) }
    caught.push(
      await ingestApiSend(
        {
          from,
          to,
          cc: toAddressList(p.cc),
          bcc: toAddressList(p.bcc),
          replyTo: toAddressList(body.reply_to_list ?? body.reply_to),
          subject: substitute(p.subject ?? str(body.subject), p.substitutions) ?? '',
          html: html ?? null,
          text: text ?? null,
          headers: { ...(headerRecord(body.headers) ?? {}), ...(headerRecord(p.headers) ?? {}) },
          attachments,
        },
        {
          via: 'sendgrid',
          providerMessageId: personalizations.length > 1 ? `${xMessageId}.${index}` : xMessageId,
          tags: categories,
          metadata: Object.fromEntries(Object.entries(customArgs).map(([k, v]) => [k, String(v)])),
        },
      ),
    )
  }
  for (const email of caught) hub.ingest(email)
  return { status: 202, headers: { 'X-Message-Id': xMessageId } }
}

/** SendGrid's v3 Mail Send, at `/sendgrid/v3/mail/send`. */
export const sendgrid: ProviderModule = {
  id: 'sendgrid',
  eventNames: EVENT_NAMES,

  register(router: Router, hub: Hub) {
    router.post('/sendgrid/v3/mail/send', (ctx) => sendgridSend(ctx, hub))
  },

  fail(kind) {
    switch (kind) {
      case 'rate_limit':
        return { ...error(429, 'too many requests'), headers: { 'X-RateLimit-Limit': '600', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(unixSeconds() + 1) } }
      case 'invalid_recipient':
        return error(400, 'Does not contain a valid address.', 'personalizations.0.to.0.email', 'http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html#message.personalizations.to')
      case 'unauthorized':
        return error(401, 'The provided authorization grant is invalid, expired, or revoked')
      case 'outage':
        return error(503, 'Service Unavailable')
    }
  },

  webhook(event, email, ctx) {
    const timestamp = unixSeconds()
    const eventId = randomBytes(16).toString('base64url').slice(0, 22)
    const base: Record<string, unknown> = {
      email: recipient(email),
      timestamp,
      'smtp-id': `<${email.providerMessageId}@groundhog.local>`,
      event: EVENT_NAMES[event],
      category: email.tags,
      sg_event_id: eventId,
      sg_message_id: `${email.providerMessageId}.groundhog.0`,
      ...email.metadata,
    }
    if (event === 'delivered') base.response = '250 2.0.0 OK'
    if (event === 'bounced') Object.assign(base, { reason: '550 5.1.1 The email account that you tried to reach does not exist.', status: '5.1.1', type: 'bounce', bounce_classification: 'Invalid Address' })
    if (event === 'opened' || event === 'clicked') Object.assign(base, { useragent: 'Groundhog', ip: '127.0.0.1', sg_machine_open: false })
    if (event === 'clicked') Object.assign(base, { url: ctx.link, url_offset: { index: 0, type: 'html' } })
    const body = JSON.stringify([base])
    const ts = String(timestamp)
    return {
      eventId,
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Twilio-Email-Event-Webhook-Timestamp': ts,
        'X-Twilio-Email-Event-Webhook-Signature': sendgridSignature(ts, body),
      },
    }
  },
}
