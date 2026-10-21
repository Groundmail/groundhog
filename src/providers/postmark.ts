import type { HttpResult, RequestContext, Router } from '../http.js'
import { ingestApiSend, toAddress, toAddressList, uuid } from '../mime.js'
import type { StoredEmail } from '../types.js'
import { attachment, headerRecord, recipient, str } from './common.js'
import type { Hub, ProviderModule } from './types.js'

const EVENT_NAMES = {
  delivered: 'Delivery',
  bounced: 'Bounce',
  complained: 'SpamComplaint',
  opened: 'Open',
  clicked: 'Click',
} as const

function error(status: number, code: number, message: string): HttpResult {
  return { status, body: { ErrorCode: code, Message: message } }
}

async function toEmail(body: Record<string, unknown>, template = false): Promise<StoredEmail | HttpResult> {
  const from = toAddress(str(body.From))
  const to = toAddressList(body.To)
  if (!from) return error(422, 300, "Invalid 'From' address: ''.")
  if (!to.length) return error(422, 300, 'Zero recipients specified')
  let html = str(body.HtmlBody)
  let text = str(body.TextBody)
  let subject = str(body.Subject) ?? ''
  if (template) {
    const ref = str(body.TemplateAlias) ?? str(body.TemplateId) ?? 'unknown'
    const model = body.TemplateModel ?? {}
    subject = subject || `Postmark template ${ref}`
    html = undefined
    text = `Sent with Postmark template ${ref}. Groundhog can't render stored templates; the model it was sent with:\n\n${JSON.stringify(model, null, 2)}`
  }
  const metadata: Record<string, string> = {}
  if (body.Metadata && typeof body.Metadata === 'object') {
    for (const [key, value] of Object.entries(body.Metadata as Record<string, unknown>)) metadata[key] = String(value)
  }
  if (body.MessageStream) metadata.MessageStream = String(body.MessageStream)
  return ingestApiSend(
    {
      from,
      to,
      cc: toAddressList(body.Cc),
      bcc: toAddressList(body.Bcc),
      replyTo: toAddressList(body.ReplyTo),
      subject,
      html: html ?? null,
      text: text ?? null,
      headers: headerRecord(body.Headers),
      attachments: Array.isArray(body.Attachments)
        ? (body.Attachments as Array<Record<string, unknown>>).map((a) => attachment(a.Name, a.Content, a.ContentType, a.ContentID))
        : undefined,
    },
    { via: 'postmark', providerMessageId: uuid(), tags: body.Tag ? [String(body.Tag)] : [], metadata },
  )
}

function isError(value: StoredEmail | HttpResult): value is HttpResult {
  return !('via' in value)
}

function sent(email: StoredEmail) {
  return {
    To: email.to.map((a) => a.address).join(', '),
    SubmittedAt: email.createdAt,
    MessageID: email.providerMessageId,
    ErrorCode: 0,
    Message: 'OK',
  }
}

async function single(ctx: RequestContext, hub: Hub, template: boolean): Promise<HttpResult | void> {
  if (await hub.guard(ctx, postmark)) return
  const result = await toEmail(await ctx.json(), template)
  if (isError(result)) return result
  hub.ingest(result)
  return { status: 200, body: sent(result) }
}

async function batch(ctx: RequestContext, hub: Hub, template: boolean): Promise<HttpResult | void> {
  if (await hub.guard(ctx, postmark)) return
  const body = await ctx.json<unknown>()
  const items = (template ? (body as { Messages?: unknown[] }).Messages : body) as Array<Record<string, unknown>> | undefined
  const out: unknown[] = []
  for (const item of items ?? []) {
    const result = await toEmail(item, template)
    if (isError(result)) {
      out.push({ ...(result.body as object), To: str(item.To) ?? '' })
      continue
    }
    hub.ingest(result)
    out.push(sent(result))
  }
  return { status: 200, body: out }
}

/** Postmark's Email API, at `/postmark`. */
export const postmark: ProviderModule = {
  id: 'postmark',
  eventNames: EVENT_NAMES,

  register(router: Router, hub: Hub) {
    router.post('/postmark/email', (ctx) => single(ctx, hub, false))
    router.post('/postmark/email/withTemplate', (ctx) => single(ctx, hub, true))
    router.post('/postmark/email/batch', (ctx) => batch(ctx, hub, false))
    router.post('/postmark/email/batchWithTemplates', (ctx) => batch(ctx, hub, true))
  },

  fail(kind) {
    switch (kind) {
      case 'rate_limit':
        return error(429, 429, 'Rate limit exceeded. Please slow down your requests.')
      case 'invalid_recipient':
        return error(422, 300, "Invalid 'To' address: 'not-an-address'.")
      case 'unauthorized':
        return error(401, 10, 'Request does not contain a valid Server token.')
      case 'outage':
        return error(503, 0, 'Service Unavailable')
    }
  },

  webhook(event, email, ctx) {
    const now = new Date().toISOString()
    const stream = email.metadata.MessageStream ?? 'outbound'
    const metadata = Object.fromEntries(Object.entries(email.metadata).filter(([key]) => key !== 'MessageStream'))
    const common = { MessageID: email.providerMessageId, ServerID: 1, MessageStream: stream, Tag: email.tags[0] ?? '', Metadata: metadata }
    const client = { Client: { Name: 'Groundhog', Company: 'Groundmail', Family: 'Groundhog' }, OS: { Name: 'Local', Company: '', Family: 'Local' }, Platform: 'Desktop', UserAgent: 'Groundhog', Geo: {} }
    const id = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000
    let payload: Record<string, unknown>
    switch (event) {
      case 'delivered':
        payload = { RecordType: 'Delivery', ...common, Recipient: recipient(email), DeliveredAt: now, Details: 'Simulated by Groundhog' }
        break
      case 'bounced':
        payload = {
          RecordType: 'Bounce', ID: id, Type: 'HardBounce', TypeCode: 1, Name: 'Hard bounce', ...common,
          Description: 'The server was unable to deliver your message (ex: unknown user, mailbox not found).',
          Details: '550 5.1.1 The email account that you tried to reach does not exist.',
          Email: recipient(email), From: email.from?.address ?? '', BouncedAt: now, DumpAvailable: false, Inactive: true, CanActivate: true, Subject: email.subject, Content: '',
        }
        break
      case 'complained':
        payload = {
          RecordType: 'SpamComplaint', ID: id, Type: 'SpamComplaint', TypeCode: 512, Name: 'Spam complaint', ...common,
          Description: '', Details: '', Email: recipient(email), From: email.from?.address ?? '', BouncedAt: now, DumpAvailable: false, Inactive: true, CanActivate: false, Subject: email.subject, Content: '',
        }
        break
      case 'opened':
        payload = { RecordType: 'Open', ...common, FirstOpen: true, ...client, ReadSeconds: 5, ReceivedAt: now, Recipient: recipient(email) }
        break
      case 'clicked':
        payload = { RecordType: 'Click', ...common, ClickLocation: 'HTML', ...client, OriginalLink: ctx.link, ReceivedAt: now, Recipient: recipient(email) }
        break
    }
    return { eventId: `${EVENT_NAMES[event]} ${id}`, body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } }
  },
}
