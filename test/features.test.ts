/** Failure simulation, webhook simulation (verified with each provider's own verifier), helpers. */
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { EventWebhook } from '@sendgrid/eventwebhook'
import sgMail from '@sendgrid/mail'
import FormData from 'form-data'
import { Groundmail, verifyWebhookSignature } from 'groundmail'
import Mailgun from 'mailgun.js'
import nodemailer from 'nodemailer'
import * as postmark from 'postmark'
import { Resend } from 'resend'
import { Webhook } from 'svix'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearEmails, extractLink, fireWebhook, listEmails, simulateFault, waitForEmail, type Groundhog } from '../src/index.js'
import { DEFAULT_SECRETS, sendgridKeyPair } from '../src/signing.js'
import { json, start } from './helpers.js'

let gh: Groundhog
let hook: Server
let hookUrl: string
const received: Array<{ headers: IncomingMessage['headers']; body: string }> = []

beforeAll(async () => {
  gh = await start()
  hook = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(req.url === '/broken' ? 500 : 200).end(req.url === '/broken' ? 'boom' : 'ok')
    })
  })
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve))
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`
})
afterAll(async () => {
  await gh.close()
  hook.close()
})
beforeEach(() => {
  gh.store.clear()
  gh.faults.clear()
  received.length = 0
})

const aws = { region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }

describe('failure simulation', () => {
  it('POST /api/faults makes the next N sends fail, then turns itself off', async () => {
    const set = await json(gh, '/api/faults', { method: 'POST', body: JSON.stringify({ status: 429, next: 2 }) })
    expect(set.body).toMatchObject({ kind: 'rate_limit', remaining: 2 })
    const gm = new Groundmail('gm_test', { baseUrl: gh.url })
    const send = () => gm.emails.send({ from: 'a@acme.test', to: 'x@example.com', subject: 's', text: 't' })
    await expect(send()).rejects.toMatchObject({ status: 429 })
    await expect(send()).rejects.toMatchObject({ status: 429 })
    await expect(send()).resolves.toMatchObject({ status: 'sent' })
    expect((await json(gh, '/api/faults')).body).toMatchObject({ kind: null, remaining: 0 })
    expect(gh.store.count()).toBe(1)
  })

  it('each provider SDK sees its own provider-shaped error', async () => {
    await simulateFault({ baseUrl: gh.url, status: 422, next: 6 })

    process.env.RESEND_BASE_URL = `${gh.url}/resend`
    const r = await new Resend('re_x').emails.send({ from: 'a@acme.test', to: 'x@example.com', subject: 's', text: 't' })
    expect(r.error).toMatchObject({ name: 'validation_error' })

    sgMail.setApiKey('SG.x')
    sgMail.client.setDefaultRequest('baseUrl', `${gh.url}/sendgrid`)
    await expect(sgMail.send({ from: 'a@acme.test', to: 'x@example.com', subject: 's', text: 't' })).rejects.toMatchObject({ code: 400 })

    const pm = new postmark.ServerClient('t', { requestHost: `127.0.0.1:${gh.httpPort}/postmark`, useHttps: false })
    await expect(pm.sendEmail({ From: 'a@acme.test', To: 'x@example.com', Subject: 's', TextBody: 't' })).rejects.toMatchObject({ statusCode: 422, code: 300 })

    const mg = new Mailgun(FormData).client({ username: 'api', key: 'k', url: `${gh.url}/mailgun` })
    await expect(mg.messages.create('mg.test', { from: 'a@mg.test', to: 'x@example.com', subject: 's', text: 't' })).rejects.toMatchObject({ status: 400 })

    const ses = new SESv2Client({ ...aws, endpoint: `${gh.url}/ses`, maxAttempts: 1 })
    await expect(ses.send(new SendEmailCommand({ FromEmailAddress: 'a@acme.test', Destination: { ToAddresses: ['x@example.com'] }, Content: { Simple: { Subject: { Data: 's' }, Body: { Text: { Data: 't' } } } } }))).rejects.toMatchObject({ name: 'BadRequestException' })

    const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: gh.smtpPort })
    await expect(smtp.sendMail({ from: 'a@acme.test', to: 'x@example.com', subject: 's', text: 't' })).rejects.toMatchObject({ responseCode: 550 })

    expect(gh.store.count()).toBe(0)
  })

  it('SMTP answers each fault with the matching reply code', async () => {
    const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: gh.smtpPort })
    const send = () => smtp.sendMail({ from: 'a@acme.test', to: 'x@example.com', subject: 's', text: 't' })
    for (const [status, code] of [[429, 450], [401, 535], ['5xx', 451]] as const) {
      await simulateFault({ baseUrl: gh.url, status, next: 1 })
      await expect(send()).rejects.toMatchObject({ responseCode: code })
    }
    await send()
    expect(gh.store.count()).toBe(1)
  })

  it('timeout drops the connection after the delay', async () => {
    await simulateFault({ baseUrl: gh.url, status: 'timeout', next: 1, timeoutMs: 100 })
    const gm = new Groundmail('gm_test', { baseUrl: gh.url })
    const started = Date.now()
    await expect(gm.emails.send({ from: 'a@acme.test', to: 'x@example.com', subject: 's', text: 't' })).rejects.toThrow()
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  it('rejects unknown kinds', async () => {
    expect((await json(gh, '/api/faults', { method: 'POST', body: JSON.stringify({ status: 418 }) })).status).toBe(400)
  })
})

describe('webhook simulation', () => {
  async function sendVia(provider: string) {
    switch (provider) {
      case 'groundmail':
        await new Groundmail('gm_test', { baseUrl: gh.url }).emails.send({ from: 'a@acme.test', to: 'ada@example.com', subject: 'Hook', html: '<a href="http://localhost:3000/x">x</a>' })
        break
      case 'resend':
        process.env.RESEND_BASE_URL = `${gh.url}/resend`
        await new Resend('re_x').emails.send({ from: 'a@acme.test', to: 'ada@example.com', subject: 'Hook', text: 't' })
        break
      case 'sendgrid':
        sgMail.client.setDefaultRequest('baseUrl', `${gh.url}/sendgrid`)
        await sgMail.send({ from: 'a@acme.test', to: 'ada@example.com', subject: 'Hook', text: 't', customArgs: { user: '42' } })
        break
      case 'postmark':
        await new postmark.ServerClient('t', { requestHost: `127.0.0.1:${gh.httpPort}/postmark`, useHttps: false }).sendEmail({ From: 'a@acme.test', To: 'ada@example.com', Subject: 'Hook', TextBody: 't' })
        break
      case 'mailgun':
        await new Mailgun(FormData).client({ username: 'api', key: 'k', url: `${gh.url}/mailgun` }).messages.create('mg.test', { from: 'a@mg.test', to: 'ada@example.com', subject: 'Hook', text: 't' })
        break
      case 'ses':
        await new SESv2Client({ ...aws, endpoint: `${gh.url}/ses` }).send(new SendEmailCommand({ FromEmailAddress: 'a@acme.test', Destination: { ToAddresses: ['ada@example.com'] }, Content: { Simple: { Subject: { Data: 'Hook' }, Body: { Text: { Data: 't' } } } } }))
        break
    }
    return gh.store.latest()!
  }

  beforeAll(async () => {
    await json(gh, '/api/webhooks', { method: 'PUT', body: JSON.stringify({ url: hookUrl, format: 'auto' }) })
  })

  it('Groundmail format, verified with the Groundmail SDK', async () => {
    const email = await sendVia('groundmail')
    const delivery = await fireWebhook({ baseUrl: gh.url, id: email.id, event: 'bounced' })
    expect(delivery).toMatchObject({ status: 200, ok: true })
    const got = received[0]
    expect(verifyWebhookSignature(DEFAULT_SECRETS.groundmail, got.body, got.headers['groundmail-signature'] as string)).toBe(true)
    expect(JSON.parse(got.body)).toMatchObject({ type: 'email.bounced', data: { email_id: email.providerMessageId, bounce_type: 'hard' } })
  })

  it('SMTP emails use the Groundmail format', async () => {
    await nodemailer.createTransport({ host: '127.0.0.1', port: gh.smtpPort }).sendMail({ from: 'a@acme.test', to: 'ada@example.com', subject: 'S', text: 't' })
    await fireWebhook({ baseUrl: gh.url, id: gh.store.latest()!.id, event: 'delivered' })
    expect(JSON.parse(received[0].body).type).toBe('email.delivered')
  })

  it('Resend format, verified with svix', async () => {
    const email = await sendVia('resend')
    await fireWebhook({ baseUrl: gh.url, id: email.id, event: 'clicked' })
    const got = received[0]
    const headers = {
      'svix-id': got.headers['svix-id'] as string,
      'svix-timestamp': got.headers['svix-timestamp'] as string,
      'svix-signature': got.headers['svix-signature'] as string,
    }
    // Throws when the signature is wrong.
    new Webhook(DEFAULT_SECRETS.resend).verify(got.body, headers)
    expect(() => new Webhook(DEFAULT_SECRETS.resend).verify(got.body + ' ', headers)).toThrow()
    const payload = JSON.parse(got.body) as { type: string; data: { email_id: string; click: { link: string } } }
    expect(payload.type).toBe('email.clicked')
    expect(payload.data.email_id).toBe(email.providerMessageId)
  })

  it('SendGrid format, verified with @sendgrid/eventwebhook', async () => {
    const email = await sendVia('sendgrid')
    await fireWebhook({ baseUrl: gh.url, id: email.id, event: 'complained' })
    const got = received[0]
    const ew = new EventWebhook()
    const key = ew.convertPublicKeyToECDSA(sendgridKeyPair().publicKeyBase64)
    expect(ew.verifySignature(key, got.body, got.headers['x-twilio-email-event-webhook-signature'] as string, got.headers['x-twilio-email-event-webhook-timestamp'] as string)).toBe(true)
    const [event] = JSON.parse(got.body)
    expect(event).toMatchObject({ event: 'spamreport', email: 'ada@example.com', user: '42' })
    expect(event.sg_message_id.startsWith(email.providerMessageId)).toBe(true)
  })

  it('Postmark format', async () => {
    const email = await sendVia('postmark')
    await fireWebhook({ baseUrl: gh.url, id: email.id, event: 'delivered' })
    expect(JSON.parse(received[0].body)).toMatchObject({ RecordType: 'Delivery', MessageID: email.providerMessageId, Recipient: 'ada@example.com' })
  })

  it('Mailgun format, signature checks out', async () => {
    const email = await sendVia('mailgun')
    await fireWebhook({ baseUrl: gh.url, id: email.id, event: 'bounced' })
    const body = JSON.parse(received[0].body)
    const { timestamp, token, signature } = body.signature
    expect(createHmac('sha256', DEFAULT_SECRETS.mailgun).update(timestamp + token).digest('hex')).toBe(signature)
    expect(body['event-data']).toMatchObject({ event: 'failed', severity: 'permanent', recipient: 'ada@example.com' })
    expect(body['event-data'].message.headers['message-id']).toBe(email.providerMessageId)
  })

  it('SES format, wrapped in an SNS notification', async () => {
    const email = await sendVia('ses')
    await fireWebhook({ baseUrl: gh.url, id: email.id, event: 'opened' })
    const got = received[0]
    expect(got.headers['x-amz-sns-message-type']).toBe('Notification')
    const sns = JSON.parse(got.body)
    expect(sns.Type).toBe('Notification')
    expect(JSON.parse(sns.Message)).toMatchObject({ eventType: 'Open', mail: { messageId: email.providerMessageId } })
  })

  it('logs the app response, including failures', async () => {
    const email = await sendVia('groundmail')
    const bad = await json(gh, `/api/emails/${email.id}/webhooks`, { method: 'POST', body: JSON.stringify({ event: 'delivered', url: hookUrl.replace('/hook', '/broken') }) })
    expect(bad.body).toMatchObject({ status: 500, ok: false, responseBody: 'boom' })
    const nothing = await json(gh, `/api/emails/${email.id}/webhooks`, { method: 'POST', body: JSON.stringify({ event: 'delivered', url: 'http://127.0.0.1:9/nothing' }) })
    expect(nothing.body).toMatchObject({ status: null, ok: false })
    const log = await json(gh, `/api/webhooks/deliveries?email=${email.id}`)
    expect(log.body.data).toHaveLength(2)
  })

  it('can fire delivered automatically', async () => {
    await json(gh, '/api/webhooks', { method: 'PUT', body: JSON.stringify({ autoDelivered: true }) })
    await sendVia('postmark')
    await new Promise((r) => setTimeout(r, 150))
    await json(gh, '/api/webhooks', { method: 'PUT', body: JSON.stringify({ autoDelivered: false }) })
    expect(JSON.parse(received[0].body).RecordType).toBe('Delivery')
  })
})

describe('test helpers', () => {
  it('waitForEmail, listEmails, extractLink, clearEmails', async () => {
    const pending = waitForEmail({ baseUrl: gh.url, to: 'helper@example.com', timeout: 3000 })
    await new Groundmail('gm_test', { baseUrl: gh.url }).emails.send({
      from: 'a@acme.test',
      to: 'helper@example.com',
      subject: 'Confirm your email',
      html: '<p>Your verification code is <b>604 112</b>.</p><a href="http://localhost:3000/confirm?token=abc&amp;u=1">Confirm</a><a href="http://localhost:3000/unsubscribe">Unsubscribe</a>',
    })
    const email = await pending
    expect(email.code).toBe('604112')
    expect(extractLink(email)).toBe('http://localhost:3000/confirm?token=abc&u=1')
    expect(extractLink(email, 'unsubscribe')).toBe('http://localhost:3000/unsubscribe')
    expect(await listEmails({ baseUrl: gh.url, to: 'helper@example.com' })).toHaveLength(1)
    await clearEmails({ baseUrl: gh.url })
    expect(await listEmails({ baseUrl: gh.url })).toHaveLength(0)
    await expect(waitForEmail({ baseUrl: gh.url, to: 'helper@example.com', timeout: 50 })).rejects.toThrow(/within 50 ms/)
  })
})
