import { randomBytes } from 'node:crypto'
import type { HttpResult, RequestContext, Router } from '../http.js'
import { ingestApiSend, parseEmail, toAddress, toAddressList } from '../mime.js'
import { mailgunSignature } from '../signing.js'
import { allRecipients, fromString, recipient } from './common.js'
import type { Hub, ProviderModule } from './types.js'

const EVENT_NAMES = {
  delivered: 'delivered',
  bounced: 'failed',
  complained: 'complained',
  opened: 'opened',
  clicked: 'clicked',
} as const

function error(status: number, message: string): HttpResult {
  return { status, body: { message } }
}

function mailgunId(domain: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return `${stamp}.${randomBytes(8).toString('hex')}@${domain}`
}

function all(fields: Array<[string, string]>, name: string): string[] {
  return fields.filter(([key]) => key === name || key === `${name}[]`).map(([, value]) => value)
}

function one(fields: Array<[string, string]>, name: string): string | undefined {
  return all(fields, name)[0]
}

async function send(ctx: RequestContext, hub: Hub): Promise<HttpResult | void> {
  if (await hub.guard(ctx, mailgun)) return
  const domain = ctx.params.domain
  const { fields, files } = await ctx.multipart()
  const from = toAddress(one(fields, 'from'))
  const to = toAddressList(all(fields, 'to'))
  if (!from) return error(400, "from parameter is missing")
  if (!to.length) return error(400, "to parameter is missing")
  const headers: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  for (const [key, value] of fields) {
    if (key.startsWith('h:')) headers[key.slice(2)] = value
    if (key.startsWith('v:')) metadata[key.slice(2)] = value
  }
  const variables = one(fields, 'h:X-Mailgun-Variables')
  if (variables) {
    try {
      for (const [key, value] of Object.entries(JSON.parse(variables) as Record<string, unknown>)) metadata[key] = String(value)
    } catch {
      // Not JSON: keep it as a header only.
    }
  }
  let html = one(fields, 'html')
  let text = one(fields, 'text')
  const template = one(fields, 'template')
  if (!html && !text && template) {
    text = `Sent with Mailgun template ${template}. Groundhog can't render stored templates; the variables it was sent with:\n\n${one(fields, 't:variables') ?? '{}'}`
  }
  const id = mailgunId(domain)
  const email = await ingestApiSend(
    {
      from,
      to,
      cc: toAddressList(all(fields, 'cc')),
      bcc: toAddressList(all(fields, 'bcc')),
      replyTo: toAddressList(one(fields, 'h:Reply-To')),
      subject: one(fields, 'subject') ?? '',
      html: html ?? null,
      text: text ?? null,
      headers,
      attachments: files
        .filter((file) => file.field === 'attachment' || file.field === 'inline')
        .map((file) => ({ filename: file.filename, content: file.content, contentType: file.contentType, cid: file.field === 'inline' ? file.filename : undefined })),
    },
    { via: 'mailgun', providerMessageId: id, tags: all(fields, 'o:tag'), metadata },
  )
  hub.ingest(email)
  return { status: 200, body: { id: `<${id}>`, message: 'Queued. Thank you.' } }
}

async function sendMime(ctx: RequestContext, hub: Hub): Promise<HttpResult | void> {
  if (await hub.guard(ctx, mailgun)) return
  const { fields, files } = await ctx.multipart()
  const message = files.find((file) => file.field === 'message')?.content ?? (one(fields, 'message') ? Buffer.from(one(fields, 'message')!) : null)
  if (!message) return error(400, "'message' parameter is missing")
  const id = mailgunId(ctx.params.domain)
  const email = await parseEmail(message, { via: 'mailgun', providerMessageId: id, envelopeTo: toAddressList(all(fields, 'to')), tags: all(fields, 'o:tag') })
  hub.ingest(email)
  return { status: 200, body: { id: `<${id}>`, message: 'Queued. Thank you.' } }
}

/** Mailgun's Messages API, at `/mailgun/v3/<domain>/messages`. */
export const mailgun: ProviderModule = {
  id: 'mailgun',
  eventNames: EVENT_NAMES,

  register(router: Router, hub: Hub) {
    router.post('/mailgun/v3/:domain/messages', (ctx) => send(ctx, hub))
    router.post('/mailgun/v3/:domain/messages.mime', (ctx) => sendMime(ctx, hub))
  },

  fail(kind) {
    switch (kind) {
      case 'rate_limit':
        return error(429, 'Too many requests')
      case 'invalid_recipient':
        return error(400, "to parameter is not a valid address. please check documentation")
      case 'unauthorized':
        return { status: 401, headers: { 'Content-Type': 'text/plain' }, body: 'Forbidden' }
      case 'outage':
        return error(503, 'Service Unavailable')
    }
  },

  webhook(event, email, ctx) {
    const timestamp = (Date.now() / 1000).toFixed(6)
    const token = randomBytes(25).toString('hex')
    const sigTimestamp = String(Math.floor(Number(timestamp)))
    const to = recipient(email)
    const eventId = randomBytes(11).toString('base64url')
    const data: Record<string, unknown> = {
      id: eventId,
      timestamp: Number(timestamp),
      'log-level': event === 'bounced' ? 'error' : event === 'complained' ? 'warn' : 'info',
      event: EVENT_NAMES[event],
      recipient: to,
      'recipient-domain': to.split('@')[1] ?? '',
      tags: email.tags,
      'user-variables': email.metadata,
      envelope: { sender: email.from?.address ?? '', transport: 'smtp', targets: allRecipients(email).join(',') },
      message: {
        headers: { to: email.to.map((a) => a.address).join(', '), 'message-id': email.providerMessageId, from: fromString(email), subject: email.subject },
        attachments: [],
        size: email.size,
      },
      flags: { 'is-routed': false, 'is-authenticated': true, 'is-system-test': false, 'is-test-mode': false },
    }
    if (event === 'delivered') data['delivery-status'] = { code: 250, message: 'OK', description: '', 'attempt-no': 1, tls: true, 'mx-host': 'localhost' }
    if (event === 'bounced') {
      Object.assign(data, { severity: 'permanent', reason: 'bounce' })
      data['delivery-status'] = { code: 550, message: '5.1.1 The email account that you tried to reach does not exist.', description: '', 'attempt-no': 1, 'bounce-type': 'hard' }
    }
    if (event === 'opened' || event === 'clicked') {
      Object.assign(data, { ip: '127.0.0.1', 'client-info': { 'client-type': 'browser', 'client-os': 'Local', 'device-type': 'desktop', 'client-name': 'Groundhog', 'user-agent': 'Groundhog' }, geolocation: { country: 'Unknown', region: 'Unknown', city: 'Unknown' } })
    }
    if (event === 'clicked') data.url = ctx.link
    const body = JSON.stringify({
      signature: { timestamp: sigTimestamp, token, signature: mailgunSignature(ctx.secrets.mailgun, sigTimestamp, token) },
      'event-data': data,
    })
    return { eventId, body, headers: { 'Content-Type': 'application/json' } }
  },
}
