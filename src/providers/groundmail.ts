import type { HttpResult, RequestContext, Router } from '../http.js'
import { ingestApiSend, newId, toAddress, toAddressList, uuid } from '../mime.js'
import { isResendClient, resendBatchRoute, resendGetRoute, resendSendRoute } from './resend.js'
import { groundmailSignature } from '../signing.js'
import type { Email, StoredEmail } from '../types.js'
import { attachment, fromString, headerRecord, str, unixSeconds } from './common.js'
import type { Hub, ProviderModule } from './types.js'

const EVENT_NAMES = {
  delivered: 'email.delivered',
  bounced: 'email.bounced',
  complained: 'email.complained',
  opened: 'email.opened',
  clicked: 'email.clicked',
} as const

function error(status: number, code: string, message: string, hint?: string): HttpResult {
  return { status, body: { error: { message, code, ...(hint ? { hint } : {}) } } }
}

function tagsOf(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .map((tag) => (typeof tag === 'string' ? tag : tag && typeof tag === 'object' ? `${(tag as { name?: string }).name}:${(tag as { value?: string }).value}` : ''))
    .filter(Boolean)
}

export async function groundmailSendFromBody(body: Record<string, unknown>, via: 'groundmail' | 'resend'): Promise<StoredEmail | HttpResult> {
  const from = toAddress(body.from as string)
  const to = toAddressList(body.to)
  if (!from) return via === 'resend' ? resendValidation('Missing `from` field.') : error(422, 'validation_error', '`from` is required')
  if (!to.length) return via === 'resend' ? resendValidation('Missing `to` field.') : error(422, 'validation_error', '`to` is required')
  const html = str(body.html ?? body.htmlBody ?? body.html_body)
  const text = str(body.text ?? body.textBody ?? body.text_body ?? body.plain_body)
  const attachments = Array.isArray(body.attachments)
    ? (body.attachments as Array<Record<string, unknown>>).map((a) =>
        attachment(a.filename ?? a.name, a.content ?? a.data, a.content_type ?? a.contentType, a.content_id ?? a.contentId ?? a.cid),
      )
    : undefined
  const metadata: Record<string, string> = {}
  if (body.metadata && typeof body.metadata === 'object') {
    for (const [key, value] of Object.entries(body.metadata as Record<string, unknown>)) metadata[key] = String(value)
  }
  const id = via === 'resend' ? uuid() : newId('msg')
  return ingestApiSend(
    {
      from,
      to,
      cc: toAddressList(body.cc),
      bcc: toAddressList(body.bcc),
      replyTo: toAddressList(body.reply_to ?? body.replyTo),
      subject: str(body.subject) ?? '',
      html: html ?? null,
      text: text ?? null,
      headers: headerRecord(body.headers),
      attachments,
      tags: tagsOf(body.tags),
      metadata,
    },
    { via, providerMessageId: id },
  )
}

function resendValidation(message: string): HttpResult {
  return { status: 422, body: { statusCode: 422, name: 'validation_error', message } }
}

export function isResult(value: StoredEmail | HttpResult): value is HttpResult {
  return 'status' in value && typeof (value as HttpResult).status === 'number' && !('via' in value)
}

export function emailView(email: Email) {
  return {
    id: email.providerMessageId,
    from: fromString(email),
    to: email.to.map((a) => a.address),
    cc: email.cc.map((a) => a.address),
    bcc: email.bcc.map((a) => a.address),
    reply_to: email.replyTo.map((a) => a.address),
    subject: email.subject,
    status: 'delivered',
    last_event: 'email.delivered',
    bounce_reason: null,
    bounce_type: null,
    held_back: [],
    test: true,
    tags: email.tags,
    scheduled_at: null,
    cancelled_at: null,
    created_at: email.createdAt,
    sent_at: email.createdAt,
    delivered_at: email.createdAt,
    bounced_at: null,
    opened_at: null,
    clicked_at: null,
  }
}

/** Groundmail's own API. Mounted at `/` and `/groundmail`. */
export const groundmail: ProviderModule = {
  id: 'groundmail',
  eventNames: EVENT_NAMES,

  register(router: Router, hub: Hub) {
    for (const base of ['', '/groundmail']) {
      router.post(`${base}/emails`, async (ctx: RequestContext) => {
        // RESEND_BASE_URL=http://localhost:3025 (no /resend) lands here too.
        if (!base && isResendClient(ctx)) return resendSendRoute(ctx, hub)
        if (await hub.guard(ctx, groundmail)) return
        const result = await groundmailSendFromBody(await ctx.json(), 'groundmail')
        if (isResult(result)) return result
        hub.ingest(result)
        return { status: 200, body: { id: result.providerMessageId, status: 'sent' } }
      })
      router.post(`${base}/emails/batch`, async (ctx: RequestContext) => {
        if (!base && isResendClient(ctx)) return resendBatchRoute(ctx, hub)
        if (await hub.guard(ctx, groundmail)) return
        const body = await ctx.json<unknown>()
        const emails = Array.isArray(body) ? body : ((body as { emails?: unknown[] }).emails ?? [])
        const data: unknown[] = []
        for (const [index, item] of (emails as Array<Record<string, unknown>>).entries()) {
          const result = await groundmailSendFromBody(item, 'groundmail')
          if (isResult(result)) {
            data.push({ index, error: (result.body as { error: unknown }).error })
            continue
          }
          hub.ingest(result)
          data.push({ index, id: result.providerMessageId, status: 'sent' })
        }
        return { status: 200, body: { data } }
      })
      router.get(`${base}/emails/:id`, (ctx: RequestContext) => {
        if (!base && isResendClient(ctx)) return resendGetRoute(ctx, hub)
        const email = hub.get(ctx.params.id)
        if (!email) return error(404, 'not_found', 'Email not found')
        return { status: 200, body: { email: emailView(email) } }
      })
    }
  },

  fail(kind) {
    switch (kind) {
      case 'rate_limit':
        return { ...error(429, 'rate_limited', 'Too many requests. Slow down and retry after the Retry-After header.'), headers: { 'Retry-After': '1' } }
      case 'invalid_recipient':
        return error(422, 'invalid_recipient', 'The recipient address is not valid.', 'Check the `to` address.')
      case 'unauthorized':
        return error(401, 'invalid_api_key', 'Invalid API key.', 'Check GROUNDMAIL_API_KEY.')
      case 'outage':
        return error(503, 'service_unavailable', 'Groundmail is temporarily unavailable. Retry with backoff.')
    }
  },

  webhook(event, email, ctx) {
    const timestamp = unixSeconds()
    const payload = {
      type: EVENT_NAMES[event],
      created_at: new Date().toISOString(),
      data: {
        email_id: email.providerMessageId,
        to: email.to.map((a) => a.address),
        from: fromString(email),
        subject: email.subject,
        status: event === 'bounced' ? 'bounced' : event === 'complained' ? 'complained' : 'delivered',
        ...(event === 'bounced' ? { bounce_reason: '550 5.1.1 The email account that you tried to reach does not exist.', bounce_type: 'hard' } : {}),
        ...(event === 'clicked' ? { link: ctx.link } : {}),
        test: true,
      },
    }
    const body = JSON.stringify(payload)
    return {
      eventId: newId('evt'),
      body,
      headers: { 'Content-Type': 'application/json', 'Groundmail-Signature': groundmailSignature(ctx.secrets.groundmail, body, timestamp) },
    }
  },
}
