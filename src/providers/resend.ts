import type { HttpResult, RequestContext, Router } from '../http.js'
import { newId } from '../mime.js'
import { svixSignature } from '../signing.js'
import { fromString, unixSeconds } from './common.js'
import { groundmailSendFromBody, isResult } from './groundmail.js'
import type { Hub, ProviderModule } from './types.js'

const EVENT_NAMES = {
  delivered: 'email.delivered',
  bounced: 'email.bounced',
  complained: 'email.complained',
  opened: 'email.opened',
  clicked: 'email.clicked',
} as const

function error(status: number, name: string, message: string): HttpResult {
  return { status, body: { statusCode: status, name, message } }
}

export function isResendClient(ctx: RequestContext): boolean {
  return ctx.header('user-agent').toLowerCase().startsWith('resend')
}

export async function resendSendRoute(ctx: RequestContext, hub: Hub): Promise<HttpResult | void> {
  if (await hub.guard(ctx, resend)) return
  const result = await groundmailSendFromBody(await ctx.json(), 'resend')
  if (isResult(result)) return result
  hub.ingest(result)
  return { status: 200, body: { id: result.providerMessageId } }
}

export async function resendBatchRoute(ctx: RequestContext, hub: Hub): Promise<HttpResult | void> {
  if (await hub.guard(ctx, resend)) return
  const body = await ctx.json<unknown>()
  const items = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : []
  if (!items.length) return error(422, 'validation_error', 'The batch must contain at least one email.')
  const caught = []
  for (const item of items) {
    const result = await groundmailSendFromBody(item, 'resend')
    if (isResult(result)) return result
    caught.push(result)
  }
  for (const email of caught) hub.ingest(email)
  return { status: 200, body: { data: caught.map((email) => ({ id: email.providerMessageId })) } }
}

export function resendGetRoute(ctx: RequestContext, hub: Hub): HttpResult {
  const email = hub.get(ctx.params.id)
  if (!email) return error(404, 'not_found', 'Email not found')
  return {
    status: 200,
    body: {
      object: 'email',
      id: email.providerMessageId,
      to: email.to.map((a) => a.address),
      from: fromString(email),
      created_at: email.createdAt,
      subject: email.subject,
      html: email.html,
      text: email.text,
      bcc: email.bcc.map((a) => a.address),
      cc: email.cc.map((a) => a.address),
      reply_to: email.replyTo.map((a) => a.address),
      last_event: 'delivered',
      scheduled_at: null,
    },
  }
}

/** The Resend API, at `/resend` (and at `/` when the request comes from the Resend SDK). */
export const resend: ProviderModule = {
  id: 'resend',
  eventNames: EVENT_NAMES,

  register(router: Router, hub: Hub) {
    router.post('/resend/emails', (ctx) => resendSendRoute(ctx, hub))
    router.post('/resend/emails/batch', (ctx) => resendBatchRoute(ctx, hub))
    router.get('/resend/emails/:id', (ctx) => resendGetRoute(ctx, hub))
  },

  fail(kind) {
    switch (kind) {
      case 'rate_limit':
        return { ...error(429, 'rate_limit_exceeded', 'Too many requests. You can only make 2 requests per second.'), headers: { 'retry-after': '1' } }
      case 'invalid_recipient':
        return error(422, 'validation_error', 'Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.')
      case 'unauthorized':
        return error(403, 'invalid_api_key', 'API key is invalid')
      case 'outage':
        return error(500, 'application_error', 'An unexpected error occurred, please try again later.')
    }
  },

  webhook(event, email, ctx) {
    const now = new Date()
    const data: Record<string, unknown> = {
      created_at: email.createdAt,
      email_id: email.providerMessageId,
      from: fromString(email),
      to: email.to.map((a) => a.address),
      subject: email.subject,
    }
    if (event === 'bounced') {
      data.bounce = { message: 'The recipient’s email address does not exist.', subType: 'General', type: 'Permanent' }
    }
    if (event === 'clicked') {
      data.click = { ipAddress: '127.0.0.1', link: ctx.link, timestamp: now.toISOString(), userAgent: 'Groundhog' }
    }
    if (event === 'opened') {
      data.open = { ipAddress: '127.0.0.1', timestamp: now.toISOString(), userAgent: 'Groundhog' }
    }
    const body = JSON.stringify({ type: EVENT_NAMES[event], created_at: now.toISOString(), data })
    const id = newId('msg')
    const timestamp = unixSeconds(now)
    return {
      eventId: id,
      body,
      headers: {
        'Content-Type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(timestamp),
        'svix-signature': svixSignature(ctx.secrets.resend, id, timestamp, body),
      },
    }
  },
}
