/**
 * Each provider's official Node SDK, unmodified, pointed at Groundhog with its own
 * base-URL/endpoint option. The email must land in the inbox with the right fields.
 */
import { SendEmailCommand as SesV1SendEmail, SendRawEmailCommand, SESClient } from '@aws-sdk/client-ses'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import sgMail from '@sendgrid/mail'
import FormData from 'form-data'
import { Groundmail } from 'groundmail'
import Mailgun from 'mailgun.js'
import nodemailer from 'nodemailer'
import * as postmark from 'postmark'
import { Resend } from 'resend'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Groundhog } from '../src/index.js'
import { json, start } from './helpers.js'

let gh: Groundhog

beforeAll(async () => {
  gh = await start()
})
afterAll(async () => {
  await gh.close()
})
beforeEach(() => {
  gh.store.clear()
})

const aws = { region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } }

describe('SMTP', () => {
  it('Nodemailer over SMTP, any credentials', async () => {
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port: gh.smtpPort, secure: false, auth: { user: 'anything', pass: 'anything' } })
    const info = await transport.sendMail({
      from: 'Acme <auth@acme.test>',
      to: 'ada@example.com',
      bcc: 'audit@example.com',
      subject: 'Your sign-in code',
      text: 'Your code is 482913',
      html: '<p>Your code is <b>482913</b></p><a href="http://localhost:3000/verify?t=abc">Verify</a>',
      attachments: [{ filename: 'hello.txt', content: 'hi there' }],
    })
    expect(info.accepted).toEqual(['ada@example.com', 'audit@example.com'])
    const email = gh.store.latest()!
    expect(email.via).toBe('smtp')
    expect(email.subject).toBe('Your sign-in code')
    expect(email.to[0].address).toBe('ada@example.com')
    expect(email.bcc.map((a) => a.address)).toEqual(['audit@example.com'])
    expect(email.code).toBe('482913')
    expect(email.links).toEqual(['http://localhost:3000/verify?t=abc'])
    expect(email.attachments[0]).toMatchObject({ filename: 'hello.txt', contentType: 'text/plain' })
  })
})

describe('Groundmail SDK', () => {
  it('sends via baseUrl and reads it back', async () => {
    const gm = new Groundmail('gm_test_anything', { baseUrl: gh.url })
    const sent = await gm.emails.send({
      from: 'Acme <hello@acme.test>',
      to: 'linus@example.com',
      subject: 'Welcome to Acme',
      html: '<h1>Welcome</h1><a href="http://localhost:3000/dashboard">Open</a>',
      attachments: [{ filename: 'a.txt', content: Buffer.from('aaa').toString('base64') }],
    } as never)
    expect(sent.id).toMatch(/^msg_/)
    expect(sent.status).toBe('sent')
    const email = gh.store.latest()!
    expect(email).toMatchObject({ via: 'groundmail', subject: 'Welcome to Acme', providerMessageId: sent.id })
    expect(email.attachments[0].filename).toBe('a.txt')
    const got = await gm.emails.get(sent.id)
    expect(got.email.subject).toBe('Welcome to Acme')
    const batch = await gm.emails.batch([
      { from: 'a@acme.test', to: 'one@example.com', subject: 'One', text: 'one' },
      { from: 'a@acme.test', to: 'two@example.com', subject: 'Two', text: 'two' },
    ])
    expect(batch.data.map((d) => d.index)).toEqual([0, 1])
    expect(gh.store.count()).toBe(3)
  })

  it('also answers under /groundmail', async () => {
    const gm = new Groundmail('gm_test_anything', { baseUrl: `${gh.url}/groundmail` })
    await gm.emails.send({ from: 'a@acme.test', to: 'x@example.com', subject: 'Prefixed', text: 'hi' })
    expect(gh.store.latest()!.subject).toBe('Prefixed')
  })

  it('returns a Groundmail-shaped validation error', async () => {
    const gm = new Groundmail('gm_test_anything', { baseUrl: gh.url })
    await expect(gm.emails.send({ from: 'a@acme.test', to: [], subject: 'x', text: 'x' } as never)).rejects.toMatchObject({ status: 422 })
  })
})

describe('Resend SDK', () => {
  it('works through RESEND_BASE_URL=<groundhog>/resend', async () => {
    process.env.RESEND_BASE_URL = `${gh.url}/resend`
    const resend = new Resend('re_anything')
    const { data, error } = await resend.emails.send({
      from: 'Acme <onboarding@acme.test>',
      to: ['grace@example.com'],
      cc: 'cc@example.com',
      subject: 'Reset your password',
      html: '<a href="http://localhost:3000/reset?t=9f2c">Reset password</a>',
      attachments: [{ filename: 'r.txt', content: Buffer.from('resend') }],
      tags: [{ name: 'category', value: 'reset' }],
    })
    expect(error).toBeNull()
    expect(data!.id).toMatch(/^[0-9a-f-]{36}$/)
    const email = gh.store.latest()!
    expect(email).toMatchObject({ via: 'resend', subject: 'Reset your password' })
    expect(email.cc[0].address).toBe('cc@example.com')
    expect(email.attachments[0].filename).toBe('r.txt')
    expect(email.tags).toEqual(['category:reset'])
    const got = await resend.emails.get(data!.id)
    expect(got.data?.subject).toBe('Reset your password')
    const batch = await resend.batch.send([
      { from: 'a@acme.test', to: 'b1@example.com', subject: 'B1', text: '1' },
      { from: 'a@acme.test', to: 'b2@example.com', subject: 'B2', text: '2' },
    ])
    expect(batch.data?.data).toHaveLength(2)
  })

  it('works at the root too (RESEND_BASE_URL=<groundhog>)', async () => {
    process.env.RESEND_BASE_URL = gh.url
    const resend = new Resend('re_anything')
    const { data } = await resend.emails.send({ from: 'a@acme.test', to: 'root@example.com', subject: 'Root', text: 'hi' })
    expect(data!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(gh.store.latest()!.via).toBe('resend')
  })
})

describe('SendGrid SDK', () => {
  it('works with setDefaultRequest baseUrl', async () => {
    sgMail.setApiKey('SG.anything')
    sgMail.client.setDefaultRequest('baseUrl', `${gh.url}/sendgrid`)
    const [response] = await sgMail.send({
      from: { email: 'billing@acme.test', name: 'Acme Billing' },
      to: 'ada@example.com',
      subject: 'Receipt #1042',
      text: 'We received $20.00',
      html: '<p>We received $20.00</p>',
      categories: ['receipt'],
      customArgs: { order: '1042' },
      attachments: [{ content: Buffer.from('pdf').toString('base64'), filename: 'receipt.pdf', type: 'application/pdf' }],
    })
    expect(response.statusCode).toBe(202)
    expect(response.headers['x-message-id']).toBeTruthy()
    const email = gh.store.latest()!
    expect(email).toMatchObject({ via: 'sendgrid', subject: 'Receipt #1042', tags: ['receipt'] })
    expect(email.from).toEqual({ name: 'Acme Billing', address: 'billing@acme.test' })
    expect(email.metadata.order).toBe('1042')
    expect(email.code).toBeNull()
  })

  it('one email per personalization (sendMultiple)', async () => {
    await sgMail.sendMultiple({ from: 'a@acme.test', to: ['m1@example.com', 'm2@example.com'], subject: 'Multi', text: 'hi' })
    expect(gh.store.list({ subject: 'Multi' })).toHaveLength(2)
  })
})

describe('Postmark SDK', () => {
  it('works with requestHost + useHttps: false', async () => {
    const client = new postmark.ServerClient('server-token', { requestHost: `127.0.0.1:${gh.httpPort}/postmark`, useHttps: false })
    const result = await client.sendEmail({
      From: 'Acme <billing@acme.test>',
      To: 'ada@example.com, bob@example.com',
      Subject: 'Your receipt',
      HtmlBody: '<p>Thanks</p>',
      TextBody: 'Thanks',
      Tag: 'receipt',
      Metadata: { order: '7' },
      Headers: [{ Name: 'X-Custom', Value: 'yes' }],
      Attachments: [{ Name: 'r.txt', Content: Buffer.from('x').toString('base64'), ContentType: 'text/plain', ContentID: null as never }],
      MessageStream: 'outbound',
    })
    expect(result.ErrorCode).toBe(0)
    expect(result.MessageID).toMatch(/^[0-9a-f-]{36}$/)
    const email = gh.store.latest()!
    expect(email).toMatchObject({ via: 'postmark', subject: 'Your receipt', tags: ['receipt'] })
    expect(email.to.map((a) => a.address)).toEqual(['ada@example.com', 'bob@example.com'])
    expect(email.headers.find(([k]) => k.toLowerCase() === 'x-custom')?.[1]).toBe('yes')
    const batch = await client.sendEmailBatch([
      { From: 'a@acme.test', To: 'p1@example.com', Subject: 'P1', TextBody: '1' },
      { From: 'a@acme.test', To: 'p2@example.com', Subject: 'P2', TextBody: '2' },
    ])
    expect(batch.map((r) => r.ErrorCode)).toEqual([0, 0])
    await client.sendEmailWithTemplate({ From: 'a@acme.test', To: 't@example.com', TemplateAlias: 'welcome', TemplateModel: { name: 'Ada' } })
    expect(gh.store.latest()!.text).toContain('"name": "Ada"')
  })
})

describe('Mailgun SDK', () => {
  it('works with the url option', async () => {
    const mg = new Mailgun(FormData).client({ username: 'api', key: 'key-anything', url: `${gh.url}/mailgun` })
    const result = await mg.messages.create('mg.acme.test', {
      from: 'Acme <team@mg.acme.test>',
      to: ['margaret@example.com'],
      subject: 'You were invited to Acme',
      text: 'Accept: http://localhost:3000/invite/77ab',
      html: '<a href="http://localhost:3000/invite/77ab">Accept invite</a>',
      'o:tag': ['invite'],
      'h:X-Thing': 'one',
      'v:team': 'research',
      attachment: [{ filename: 'invite.txt', data: Buffer.from('hello') }],
    })
    expect(result.status).toBe(200)
    expect(result.id).toMatch(/^<.+@mg\.acme\.test>$/)
    const email = gh.store.latest()!
    expect(email).toMatchObject({ via: 'mailgun', subject: 'You were invited to Acme', tags: ['invite'] })
    expect(email.metadata.team).toBe('research')
    expect(email.links).toEqual(['http://localhost:3000/invite/77ab'])
    expect(email.attachments[0].filename).toBe('invite.txt')
  })

  it('messages.mime', async () => {
    const mg = new Mailgun(FormData).client({ username: 'api', key: 'key-anything', url: `${gh.url}/mailgun` })
    const mime = 'From: a@mg.acme.test\r\nTo: mime@example.com\r\nSubject: Raw MIME\r\n\r\nhello\r\n'
    await mg.messages.create('mg.acme.test', { to: 'mime@example.com', message: Buffer.from(mime) } as never)
    expect(gh.store.latest()!.subject).toBe('Raw MIME')
  })
})

describe('Amazon SES SDKs', () => {
  it('SESv2 SendEmail via endpoint', async () => {
    const client = new SESv2Client({ ...aws, endpoint: `${gh.url}/ses` })
    const out = await client.send(
      new SendEmailCommand({
        FromEmailAddress: 'Acme <no-reply@acme.test>',
        Destination: { ToAddresses: ['ses@example.com'], BccAddresses: ['hidden@example.com'] },
        Content: { Simple: { Subject: { Data: 'SES v2' }, Body: { Text: { Data: 'code 112233' }, Html: { Data: '<p>code 112233</p>' } } } },
        EmailTags: [{ Name: 'flow', Value: 'signup' }],
      }),
    )
    expect(out.MessageId).toBeTruthy()
    const email = gh.store.latest()!
    expect(email).toMatchObject({ via: 'ses', subject: 'SES v2', code: '112233', providerMessageId: out.MessageId })
    expect(email.bcc[0].address).toBe('hidden@example.com')
  })

  it('SESv2 raw content', async () => {
    const client = new SESv2Client({ ...aws, endpoint: `${gh.url}/ses` })
    const raw = 'From: a@acme.test\r\nTo: raw@example.com\r\nSubject: SES raw\r\n\r\nraw body\r\n'
    await client.send(new SendEmailCommand({ Content: { Raw: { Data: Buffer.from(raw) } } }))
    expect(gh.store.latest()!.subject).toBe('SES raw')
  })

  it('SES v1 SendEmail and SendRawEmail', async () => {
    const client = new SESClient({ ...aws, endpoint: `${gh.url}/ses` })
    const out = await client.send(
      new SesV1SendEmail({ Source: 'a@acme.test', Destination: { ToAddresses: ['v1@example.com'] }, Message: { Subject: { Data: 'SES v1' }, Body: { Html: { Data: '<p>Hi</p>' } } } }),
    )
    expect(out.MessageId).toBeTruthy()
    expect(gh.store.latest()!.subject).toBe('SES v1')
    const raw = 'From: a@acme.test\r\nTo: v1raw@example.com\r\nSubject: SES v1 raw\r\n\r\nbody\r\n'
    await client.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw) } }))
    expect(gh.store.latest()!.subject).toBe('SES v1 raw')
  })
})

describe('testing API', () => {
  it('lists, filters, waits and deletes', async () => {
    const waiting = json(gh, '/api/wait?to=later@example.com&timeout=5000')
    await new Promise((r) => setTimeout(r, 100))
    const gm = new Groundmail('gm_test', { baseUrl: gh.url })
    await gm.emails.send({ from: 'a@acme.test', to: 'later@example.com', subject: 'Later', text: 'Your code: 7781' })
    const waited = await waiting
    expect(waited.status).toBe(200)
    expect(waited.body).toMatchObject({ subject: 'Later', code: '7781' })
    const list = await json(gh, '/api/emails?to=later@example.com')
    expect(list.body.data).toHaveLength(1)
    const missing = await json(gh, '/api/wait?to=nobody@example.com&timeout=50')
    expect(missing.status).toBe(408)
    const source = await fetch(`${gh.url}/api/emails/${waited.body.id}/source`).then((r) => r.text())
    expect(source).toContain('Subject: Later')
    expect((await json(gh, `/api/emails/${waited.body.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await json(gh, `/api/emails/${waited.body.id}`)).status).toBe(404)
  })
})
