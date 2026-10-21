import { randomBytes } from 'node:crypto'
import type { HttpResult, RequestContext, Router } from '../http.js'
import { ingestApiSend, parseEmail, toAddress, toAddressList, uuid } from '../mime.js'
import type { FaultKind, StoredEmail } from '../types.js'
import { allRecipients, attachment, decodeContent, headerRecord } from './common.js'
import type { Hub, ProviderModule } from './types.js'

const EVENT_NAMES = {
  delivered: 'Delivery',
  bounced: 'Bounce',
  complained: 'Complaint',
  opened: 'Open',
  clicked: 'Click',
} as const

function sesMessageId(): string {
  return `0100${randomBytes(6).toString('hex')}-${uuid()}-000000`
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const V2_ERRORS: Record<Exclude<FaultKind, 'timeout'>, { status: number; type: string; message: string }> = {
  rate_limit: { status: 429, type: 'TooManyRequestsException', message: 'Maximum sending rate exceeded.' },
  invalid_recipient: { status: 400, type: 'BadRequestException', message: "Missing final '@domain'" },
  unauthorized: { status: 403, type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' },
  outage: { status: 503, type: 'ServiceUnavailable', message: 'Service is unavailable. Please try again later.' },
}

const V1_ERRORS: Record<Exclude<FaultKind, 'timeout'>, { status: number; code: string; type: string; message: string }> = {
  rate_limit: { status: 400, code: 'Throttling', type: 'Sender', message: 'Maximum sending rate exceeded.' },
  invalid_recipient: { status: 400, code: 'InvalidParameterValue', type: 'Sender', message: "Missing final '@domain'" },
  unauthorized: { status: 403, code: 'InvalidClientTokenId', type: 'Sender', message: 'The security token included in the request is invalid.' },
  outage: { status: 503, code: 'ServiceUnavailable', type: 'Receiver', message: 'Service is unavailable. Please try again later.' },
}

function v2Error(status: number, type: string, message: string): HttpResult {
  return { status, headers: { 'x-amzn-ErrorType': type, 'x-amzn-RequestId': uuid() }, body: { message } }
}

function v1Error(status: number, code: string, type: string, message: string): HttpResult {
  return {
    status,
    headers: { 'Content-Type': 'text/xml' },
    body: `<ErrorResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><Error><Type>${type}</Type><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error><RequestId>${uuid()}</RequestId></ErrorResponse>`,
  }
}

function isV1(ctx: RequestContext): boolean {
  return ctx.method === 'POST' && !ctx.url.pathname.includes('/v2/') && ctx.header('content-type').includes('x-www-form-urlencoded')
}

type V2Body = {
  FromEmailAddress?: string
  Destination?: { ToAddresses?: string[]; CcAddresses?: string[]; BccAddresses?: string[] }
  ReplyToAddresses?: string[]
  Content?: {
    Simple?: {
      Subject?: { Data?: string }
      Body?: { Text?: { Data?: string }; Html?: { Data?: string } }
      Headers?: Array<{ Name: string; Value: string }>
      Attachments?: Array<{ RawContent?: string; FileName?: string; ContentType?: string; ContentId?: string }>
    }
    Raw?: { Data?: string }
    Template?: { TemplateName?: string; TemplateArn?: string; TemplateData?: string; TemplateContent?: { Subject?: string; Text?: string; Html?: string } }
  }
  EmailTags?: Array<{ Name: string; Value: string }>
  ConfigurationSetName?: string
}

function render(template: string | undefined, data: Record<string, unknown>): string | undefined {
  if (!template) return template
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = key.split('.').reduce<unknown>((obj, part) => (obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[part] : undefined), data)
    return value == null ? '' : String(value)
  })
}

async function sendV2(ctx: RequestContext, hub: Hub): Promise<HttpResult | void> {
  if (await hub.guard(ctx, ses)) return
  const body = await ctx.json<V2Body>()
  const messageId = sesMessageId()
  const tags = (body.EmailTags ?? []).map((tag) => `${tag.Name}:${tag.Value}`)
  const metadata: Record<string, string> = body.ConfigurationSetName ? { ConfigurationSetName: body.ConfigurationSetName } : {}
  let email: StoredEmail
  if (body.Content?.Raw?.Data) {
    email = await parseEmail(decodeContent(body.Content.Raw.Data), {
      via: 'ses',
      providerMessageId: messageId,
      envelopeTo: toAddressList([...(body.Destination?.ToAddresses ?? []), ...(body.Destination?.CcAddresses ?? []), ...(body.Destination?.BccAddresses ?? [])]),
      tags,
      metadata,
    })
  } else {
    const from = toAddress(body.FromEmailAddress)
    const to = toAddressList(body.Destination?.ToAddresses)
    const cc = toAddressList(body.Destination?.CcAddresses)
    const bcc = toAddressList(body.Destination?.BccAddresses)
    if (!from) return v2Error(400, 'BadRequestException', 'FromEmailAddress is required.')
    if (!to.length && !cc.length && !bcc.length) return v2Error(400, 'BadRequestException', 'Missing required field Destination')
    let subject = body.Content?.Simple?.Subject?.Data ?? ''
    let html = body.Content?.Simple?.Body?.Html?.Data
    let text = body.Content?.Simple?.Body?.Text?.Data
    const template = body.Content?.Template
    if (template) {
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(template.TemplateData ?? '{}')
      } catch {
        // Keep the raw data in the text below.
      }
      if (template.TemplateContent) {
        subject = render(template.TemplateContent.Subject, data) ?? ''
        html = render(template.TemplateContent.Html, data)
        text = render(template.TemplateContent.Text, data)
      } else {
        const name = template.TemplateName ?? template.TemplateArn ?? 'unknown'
        subject = `SES template ${name}`
        text = `Sent with SES template ${name}. Groundhog can't render stored templates; the data it was sent with:\n\n${template.TemplateData ?? '{}'}`
      }
    }
    email = await ingestApiSend(
      {
        from,
        to,
        cc,
        bcc,
        replyTo: toAddressList(body.ReplyToAddresses),
        subject,
        html: html ?? null,
        text: text ?? null,
        headers: headerRecord(body.Content?.Simple?.Headers),
        attachments: body.Content?.Simple?.Attachments?.map((a) => attachment(a.FileName, a.RawContent, a.ContentType, a.ContentId)),
      },
      { via: 'ses', providerMessageId: messageId, tags, metadata },
    )
  }
  hub.ingest(email)
  return { status: 200, headers: { 'x-amzn-RequestId': uuid() }, body: { MessageId: messageId } }
}

function members(pairs: Array<[string, string]>, prefix: string): string[] {
  return pairs
    .filter(([key]) => key.startsWith(`${prefix}.member.`))
    .sort(([a], [b]) => Number(a.split('.').pop()) - Number(b.split('.').pop()))
    .map(([, value]) => value)
}

async function sendV1(ctx: RequestContext, hub: Hub): Promise<HttpResult | void> {
  const pairs = await ctx.formPairs()
  const get = (key: string) => pairs.find(([k]) => k === key)?.[1]
  const action = get('Action')
  if (action !== 'SendEmail' && action !== 'SendRawEmail') {
    return v1Error(400, 'InvalidAction', 'Sender', `Groundhog only emulates SendEmail and SendRawEmail (got ${action ?? 'nothing'}).`)
  }
  if (await hub.guard(ctx, ses)) return
  const messageId = sesMessageId()
  const tags: string[] = []
  for (let i = 1; get(`Tags.member.${i}.Name`); i += 1) tags.push(`${get(`Tags.member.${i}.Name`)}:${get(`Tags.member.${i}.Value`) ?? ''}`)
  let email: StoredEmail
  if (action === 'SendRawEmail') {
    const data = get('RawMessage.Data')
    if (!data) return v1Error(400, 'InvalidParameterValue', 'Sender', 'RawMessage.Data is required.')
    email = await parseEmail(Buffer.from(data, 'base64'), { via: 'ses', providerMessageId: messageId, envelopeTo: toAddressList(members(pairs, 'Destinations')), tags })
  } else {
    const from = toAddress(get('Source'))
    if (!from) return v1Error(400, 'InvalidParameterValue', 'Sender', 'Missing required header Source.')
    email = await ingestApiSend(
      {
        from,
        to: toAddressList(members(pairs, 'Destination.ToAddresses')),
        cc: toAddressList(members(pairs, 'Destination.CcAddresses')),
        bcc: toAddressList(members(pairs, 'Destination.BccAddresses')),
        replyTo: toAddressList(members(pairs, 'ReplyToAddresses')),
        subject: get('Message.Subject.Data') ?? '',
        html: get('Message.Body.Html.Data') ?? null,
        text: get('Message.Body.Text.Data') ?? null,
      },
      { via: 'ses', providerMessageId: messageId, tags },
    )
  }
  hub.ingest(email)
  const requestId = uuid()
  return {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: `<${action}Response xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><${action}Result><MessageId>${messageId}</MessageId></${action}Result><ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata></${action}Response>`,
  }
}

/** Amazon SES: the v2 JSON API (`/ses/v2/email/outbound-emails`) and the v1 query API (`POST /ses`). */
export const ses: ProviderModule = {
  id: 'ses',
  eventNames: EVENT_NAMES,

  register(router: Router, hub: Hub) {
    router.post('/ses/v2/email/outbound-emails', (ctx) => sendV2(ctx, hub))
    router.post('/ses', (ctx) => sendV1(ctx, hub))
  },

  fail(kind, ctx) {
    if (ctx && isV1(ctx)) {
      const e = V1_ERRORS[kind]
      return v1Error(e.status, e.code, e.type, e.message)
    }
    const e = V2_ERRORS[kind]
    return v2Error(e.status, e.type, e.message)
  },

  webhook(event, email, ctx) {
    const now = new Date().toISOString()
    const recipients = allRecipients(email)
    const sesEvent: Record<string, unknown> = {
      eventType: EVENT_NAMES[event],
      mail: {
        timestamp: email.createdAt,
        source: email.from?.address ?? '',
        sourceArn: `arn:aws:ses:us-east-1:000000000000:identity/${email.from?.address.split('@')[1] ?? 'localhost'}`,
        sendingAccountId: '000000000000',
        messageId: email.providerMessageId,
        destination: recipients,
        headersTruncated: false,
        headers: email.headers.slice(0, 20).map(([name, value]) => ({ name, value })),
        commonHeaders: {
          from: email.from ? [email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address] : [],
          to: email.to.map((a) => a.address),
          messageId: email.providerMessageId,
          subject: email.subject,
        },
        tags: Object.fromEntries(email.tags.map((tag) => tag.split(':')).map(([k, ...v]) => [k, [v.join(':')]])),
      },
    }
    const feedbackId = sesMessageId()
    switch (event) {
      case 'delivered':
        sesEvent.delivery = { timestamp: now, processingTimeMillis: 512, recipients, smtpResponse: '250 2.6.0 Message received', reportingMTA: 'groundhog.local' }
        break
      case 'bounced':
        sesEvent.bounce = {
          bounceType: 'Permanent', bounceSubType: 'General', timestamp: now, feedbackId, reportingMTA: 'dsn; groundhog.local',
          bouncedRecipients: [{ emailAddress: recipients[0], action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }],
        }
        break
      case 'complained':
        sesEvent.complaint = { complainedRecipients: [{ emailAddress: recipients[0] }], timestamp: now, feedbackId, userAgent: 'Groundhog', complaintFeedbackType: 'abuse', arrivalDate: now }
        break
      case 'opened':
        sesEvent.open = { ipAddress: '127.0.0.1', timestamp: now, userAgent: 'Groundhog' }
        break
      case 'clicked':
        sesEvent.click = { ipAddress: '127.0.0.1', timestamp: now, userAgent: 'Groundhog', link: ctx.link, linkTags: {} }
        break
    }
    const id = uuid()
    const topic = 'arn:aws:sns:us-east-1:000000000000:groundhog-ses-events'
    const notification = {
      Type: 'Notification',
      MessageId: id,
      TopicArn: topic,
      Message: JSON.stringify(sesEvent),
      Timestamp: now,
      SignatureVersion: '1',
      // AWS signs SNS messages with its own certificate, which can't be reproduced locally.
      Signature: randomBytes(256).toString('base64'),
      SigningCertURL: `${ctx.baseUrl}/ses/sns-signing-cert.pem`,
      UnsubscribeURL: `${ctx.baseUrl}/ses/sns-unsubscribe?SubscriptionArn=${encodeURIComponent(topic)}`,
    }
    return {
      eventId: id,
      body: JSON.stringify(notification),
      headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': 'Notification', 'x-amz-sns-message-id': id, 'x-amz-sns-topic-arn': topic },
    }
  },
}

