import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SMTPServer } from 'smtp-server'
import { FAULT_LABELS, Faults, parseFaultKind } from './faults.js'
import { GroundmailAccount, withUtm } from './groundmail-account.js'
import { HttpError, RequestContext, Router, type HttpResult } from './http.js'
import { ingestApiSend } from './mime.js'
import { HTTP_PROVIDERS, PROVIDER_MODULES, WEBHOOK_FORMATS } from './providers/index.js'
import type { Hub, ProviderModule } from './providers/types.js'
import { createSmtpServer, SMTP_FAULT_REPLIES } from './smtp.js'
import { EmailStore, publicEmail, type EmailFilter } from './store.js'
import { PROVIDER_LABELS, WEBHOOK_EVENTS, type Email, type FaultKind, type StoredEmail, type WebhookEvent } from './types.js'
import { formatFor, verificationKeys, Webhooks, type WebhookSettings } from './webhooks.js'

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }
    return pkg.version
  } catch {
    return '0.0.0'
  }
})()

export type GroundhogOptions = {
  /** SMTP port. Default 1025. 0 picks a free port. */
  smtpPort?: number
  /** HTTP port (web UI, testing API, provider APIs). Default 3025. 0 picks a free port. */
  httpPort?: number
  /** `localhost` (default) listens on 127.0.0.1 and ::1. Use `0.0.0.0` in containers. */
  host?: string
  /** Most emails kept; older ones drop off. Default 1000. */
  maxEmails?: number
  /** Save the inbox to this JSON file and load it on start. */
  storeFile?: string
  webhooks?: Partial<WebhookSettings>
  /** How long a simulated timeout holds a connection. Default 30 000 ms. */
  faultTimeoutMs?: number
  /** Disable the SMTP listener. */
  smtp?: boolean
  /** Groundmail API base URL for "Send to my real inbox". */
  groundmailApiUrl?: string
  openBrowser?: (url: string) => void
  log?: (line: string) => void
}

export type Groundhog = {
  url: string
  smtpPort: number
  httpPort: number
  host: string
  store: EmailStore
  faults: Faults
  webhooks: Webhooks
  account: GroundmailAccount
  close(): Promise<void>
}

const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

function summary(email: Email) {
  const { html: _html, text, headers: _headers, ...rest } = email
  return { ...rest, preview: (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) }
}

function filterFrom(ctx: RequestContext): EmailFilter {
  return {
    to: ctx.query('to'),
    from: ctx.query('from'),
    subject: ctx.query('subject'),
    q: ctx.query('q') ?? ctx.query('query'),
    via: ctx.query('via'),
    since: ctx.query('since'),
  }
}

/** Point cid: images at the attachment URL so inline images render. */
function htmlForFrame(email: StoredEmail, scheme: string | undefined): string {
  let html = email.html ?? `<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,Menlo,monospace">${(email.text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`
  for (const attachment of email.attachments) {
    if (!attachment.contentId) continue
    const url = `/api/emails/${email.id}/attachments/${attachment.id}`
    html = html.split(`cid:${attachment.contentId}`).join(url)
  }
  const base = '<base target="_blank">'
  const darkStyle = scheme === 'dark' ? '<meta name="color-scheme" content="dark"><style>:root{color-scheme:dark}</style>' : '<meta name="color-scheme" content="light">'
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${base}${darkStyle}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${base}${darkStyle}</head>`)
  return `<!doctype html><html><head><meta charset="utf-8">${base}${darkStyle}</head><body>${html}</body></html>`
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const SAMPLE_CODE = () => String(Math.floor(100000 + Math.random() * 900000))

export async function startGroundhog(options: GroundhogOptions = {}): Promise<Groundhog> {
  const log = options.log ?? (() => {})
  const store = new EmailStore({ max: options.maxEmails, file: options.storeFile })
  await store.load()
  const faults = new Faults(options.faultTimeoutMs ?? 30_000)
  let baseUrl = 'http://localhost:3025'
  const webhooks = new Webhooks(options.webhooks ?? {}, () => baseUrl)
  const account = new GroundmailAccount({ apiUrl: options.groundmailApiUrl, openBrowser: options.openBrowser })
  const sse = new Set<RequestContext>()

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of sse) client.res.write(payload)
  }

  const ingest = (email: StoredEmail): StoredEmail => {
    store.add(email)
    log(`caught ${email.id} via ${email.via}: "${email.subject}" → ${email.to.map((a) => a.address).join(', ') || '(no to)'}`)
    if (webhooks.settings.autoDelivered && webhooks.settings.url) {
      void webhooks.fire(email, 'delivered').catch(() => {})
    }
    return email
  }

  store.on('email', (email: StoredEmail) => broadcast('email', summary(publicEmail(email))))
  store.on('delete', (id: string) => broadcast('delete', { id }))
  store.on('clear', () => broadcast('clear', {}))
  faults.on('change', (state) => broadcast('faults', state))
  webhooks.on('delivery', (entry) => broadcast('webhook', entry))
  webhooks.on('settings', (settings) => broadcast('webhook-settings', settings))
  account.on('change', (status) => broadcast('account', status))

  const hub: Hub = {
    ingest,
    get: (id) => store.get(id),
    async guard(ctx: RequestContext, provider: ProviderModule) {
      const kind = faults.take()
      if (!kind) return false
      log(`simulated ${FAULT_LABELS[kind].label.toLowerCase()} on ${PROVIDER_LABELS[provider.id]} ${ctx.method} ${ctx.url.pathname}`)
      broadcast('fault-fired', { kind, provider: provider.id, path: ctx.url.pathname })
      if (kind === 'timeout') {
        await sleep(faults.get().timeoutMs)
        ctx.req.socket.destroy()
        return true
      }
      ctx.send(provider.fail(kind, ctx))
      return true
    },
  }

  const router = new Router()
  for (const provider of HTTP_PROVIDERS) provider.register?.(router, hub)

  // ---- Testing API ---------------------------------------------------------
  router.get('/api/health', () => ({
    status: 200,
    body: { ok: true, name: 'groundhog', version: VERSION, smtpPort, httpPort, emails: store.count() },
  }))

  router.get('/api/info', () => ({
    status: 200,
    body: {
      version: VERSION,
      smtpPort,
      httpPort,
      url: baseUrl,
      providers: Object.fromEntries(HTTP_PROVIDERS.map((p) => [p.id, { label: PROVIDER_LABELS[p.id], events: p.eventNames }])),
      faultReplies: { smtp: SMTP_FAULT_REPLIES },
      links: {
        groundmail: withUtm('https://groundmail.dev/', 'header'),
        signup: withUtm('https://app.groundmail.dev/signup', 'go_live'),
        docs: withUtm('https://docs.groundmail.dev/', 'go_live'),
        repo: 'https://github.com/Groundmail/groundhog',
      },
    },
  }))

  router.get('/api/emails', (ctx) => {
    const limit = Math.min(Number(ctx.query('limit')) || 100, 1000)
    const emails = store.list(filterFrom(ctx), limit).map(publicEmail)
    const brief = ctx.query('summary') === '1' || ctx.query('summary') === 'true'
    return { status: 200, body: { data: brief ? emails.map(summary) : emails, total: store.count() } }
  })

  router.delete('/api/emails', () => {
    store.clear()
    return { status: 200, body: { deleted: true } }
  })

  router.get('/api/emails/latest', (ctx) => {
    const email = store.latest(filterFrom(ctx))
    if (!email) return { status: 404, body: { error: 'No email matches' } }
    return { status: 200, body: publicEmail(email) }
  })

  router.post('/api/emails/sample', async () => {
    const code = SAMPLE_CODE()
    const email = await ingestApiSend(
      {
        from: { name: 'Acme', address: 'auth@acme.test' },
        to: [{ name: 'Ada', address: 'ada@example.com' }],
        subject: 'Your Acme sign-in code',
        html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:10px;padding:32px;color:#111827"><div style="font-size:13px;font-weight:700;letter-spacing:.4px;color:#6b7280">ACME</div><h1 style="font-size:22px;margin:12px 0">Your sign-in code</h1><p style="color:#374151;line-height:1.5">Enter this code to finish signing in. It expires in 10 minutes.</p><div style="font:700 30px ui-monospace,Menlo,monospace;letter-spacing:8px;text-align:center;padding:14px;background:#f3f4f6;border-radius:8px">${code}</div><p style="margin-top:20px"><a href="http://localhost:3000/login?code=${code}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Sign in</a></p><p style="font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:14px">A sample email from Groundhog. Nothing was sent anywhere.</p></div></body></html>`,
        text: `Your sign-in code\n\nEnter this code to finish signing in. It expires in 10 minutes.\n\n${code}\n\nSign in: http://localhost:3000/login?code=${code}`,
      },
      { via: 'smtp', tags: ['sample'] },
    )
    ingest(email)
    return { status: 201, body: publicEmail(email) }
  })

  router.get('/api/emails/:id', (ctx) => {
    const email = store.get(ctx.params.id)
    if (!email) throw new HttpError(404, 'Email not found')
    return { status: 200, body: publicEmail(email) }
  })

  router.delete('/api/emails/:id', (ctx) => {
    if (!store.delete(ctx.params.id)) throw new HttpError(404, 'Email not found')
    return { status: 200, body: { deleted: true } }
  })

  router.get('/api/emails/:id/source', (ctx) => {
    const email = store.get(ctx.params.id)
    if (!email) throw new HttpError(404, 'Email not found')
    const download = ctx.query('download') != null
    return {
      status: 200,
      headers: {
        'Content-Type': download ? 'message/rfc822' : 'text/plain; charset=utf-8',
        ...(download ? { 'Content-Disposition': `attachment; filename="${email.id}.eml"` } : {}),
      },
      body: email.raw,
    }
  })

  router.get('/api/emails/:id/html', (ctx) => {
    const email = store.get(ctx.params.id)
    if (!email) throw new HttpError(404, 'Email not found')
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' *; font-src * data:; media-src * data:",
        'X-Content-Type-Options': 'nosniff',
      },
      body: htmlForFrame(email, ctx.query('scheme')),
    }
  })

  router.get('/api/emails/:id/attachments/:aid', (ctx) => {
    const email = store.get(ctx.params.id)
    const info = email?.attachments.find((a) => a.id === ctx.params.aid)
    const content = info && email?.attachmentContent.get(info.id)
    if (!email || !info || !content) throw new HttpError(404, 'Attachment not found')
    const inline = ctx.query('download') == null && /^image\//.test(info.contentType)
    return {
      status: 200,
      headers: {
        'Content-Type': info.contentType,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${info.filename.replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      },
      body: content,
    }
  })

  router.get('/api/wait', async (ctx) => {
    const timeout = Math.min(Math.max(Number(ctx.query('timeout')) || 30_000, 0), 300_000)
    const controller = new AbortController()
    ctx.req.on('close', () => controller.abort())
    const email = await store.waitFor(filterFrom(ctx), timeout, controller.signal)
    if (!email) return { status: 408, body: { error: `No matching email within ${timeout} ms` } }
    return { status: 200, body: publicEmail(email) }
  })

  // ---- Failure simulation --------------------------------------------------
  router.get('/api/faults', () => ({ status: 200, body: faults.get() }))
  router.post('/api/faults', async (ctx) => {
    const body = await ctx.json<{ status?: unknown; kind?: unknown; next?: unknown; timeoutMs?: unknown; timeout_ms?: unknown }>()
    const kind = parseFaultKind(body.kind ?? body.status ?? ctx.query('status') ?? ctx.query('kind'))
    if (!kind) throw new HttpError(400, 'Say which failure: status 429, 422, 401, 5xx or timeout (or kind rate_limit, invalid_recipient, unauthorized, outage, timeout)')
    const next = Number(body.next ?? ctx.query('next') ?? 1)
    if (!Number.isFinite(next) || next < 0) throw new HttpError(400, '`next` must be 0 or more')
    const timeoutMs = body.timeoutMs ?? body.timeout_ms
    return { status: 200, body: faults.set(kind as FaultKind, next, timeoutMs == null ? undefined : Number(timeoutMs)) }
  })
  router.delete('/api/faults', () => ({ status: 200, body: faults.clear() }))

  // ---- Webhook simulation --------------------------------------------------
  const webhookSettingsView = () => ({ ...webhooks.settings, formats: WEBHOOK_FORMATS, events: WEBHOOK_EVENTS, verification: verificationKeys(webhooks.settings) })
  router.get('/api/webhooks', () => ({ status: 200, body: webhookSettingsView() }))
  router.put('/api/webhooks', async (ctx) => {
    try {
      webhooks.update(await ctx.json())
    } catch (error) {
      throw new HttpError(400, (error as Error).message)
    }
    return { status: 200, body: webhookSettingsView() }
  })
  router.get('/api/webhooks/deliveries', (ctx) => ({ status: 200, body: { data: webhooks.deliveries(ctx.query('email')) } }))
  router.delete('/api/webhooks/deliveries', () => {
    webhooks.clearLog()
    return { status: 200, body: { deleted: true } }
  })
  router.post('/api/emails/:id/webhooks', async (ctx) => {
    const email = store.get(ctx.params.id)
    if (!email) throw new HttpError(404, 'Email not found')
    const body = await ctx.json<{ event?: string; url?: string; format?: WebhookSettings['format']; link?: string }>()
    const event = (body.event ?? ctx.query('event') ?? '').replace(/^email\./, '') as WebhookEvent
    const aliases: Record<string, WebhookEvent> = { bounce: 'bounced', failed: 'bounced', spamreport: 'complained', complaint: 'complained', open: 'opened', click: 'clicked', delivery: 'delivered' }
    const resolved = (WEBHOOK_EVENTS as string[]).includes(event) ? event : aliases[event.toLowerCase()]
    if (!resolved) throw new HttpError(400, `event must be one of ${WEBHOOK_EVENTS.join(', ')}`)
    try {
      const entry = await webhooks.fire(publicEmail(email), resolved, { url: body.url, format: body.format, link: body.link })
      return { status: 200, body: entry }
    } catch (error) {
      throw new HttpError(400, (error as Error).message)
    }
  })
  router.get('/api/emails/:id/webhooks/format', (ctx) => {
    const email = store.get(ctx.params.id)
    if (!email) throw new HttpError(404, 'Email not found')
    const format = formatFor(email, webhooks.settings.format)
    return { status: 200, body: { format, events: PROVIDER_MODULES[format].eventNames } }
  })

  // ---- Groundmail: send to my real inbox ----------------------------------
  router.get('/api/groundmail', () => ({ status: 200, body: account.status() }))
  router.post('/api/groundmail/connect', async () => {
    try {
      return { status: 200, body: await account.connect() }
    } catch (error) {
      throw new HttpError(502, (error as Error).message)
    }
  })
  router.post('/api/groundmail/disconnect', async () => ({ status: 200, body: await account.disconnect() }))
  router.post('/api/emails/:id/send-to-inbox', async (ctx) => {
    const email = store.get(ctx.params.id)
    if (!email) throw new HttpError(404, 'Email not found')
    const body = await ctx.json<{ to?: string }>()
    try {
      return { status: 200, body: await account.sendCopy(email, body.to) }
    } catch (error) {
      throw new HttpError(400, (error as Error).message)
    }
  })

  // ---- Live updates --------------------------------------------------------
  router.get('/api/events', (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    ctx.res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION, faults: faults.get(), account: account.status() })}\n\n`)
    sse.add(ctx)
    const ping = setInterval(() => ctx.res.write(': ping\n\n'), 20_000)
    ctx.req.on('close', () => {
      clearInterval(ping)
      sse.delete(ctx)
    })
  })

  // ---- Web UI --------------------------------------------------------------
  const serveFile = (relative: string): HttpResult => {
    const path = normalize(join(UI_DIR, relative))
    if (!path.startsWith(UI_DIR)) throw new HttpError(404, 'Not found')
    try {
      const content = readFileSync(path)
      return { status: 200, headers: { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }, body: content }
    } catch {
      throw new HttpError(404, 'Not found')
    }
  }
  router.get('/', () => serveFile('index.html'))
  router.get('/ui/*', (ctx) => serveFile(ctx.params.rest))
  router.get('/favicon.ico', () => serveFile('favicon.svg'))

  const handle = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const ctx = new RequestContext(req, res)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', '*')
    if (ctx.method === 'OPTIONS') return ctx.send({ status: 204 })
    try {
      const match = router.match(ctx.method, ctx.url.pathname)
      if (match === 'method') throw new HttpError(405, `${ctx.method} is not supported on ${ctx.url.pathname}`)
      if (!match) {
        throw new HttpError(404, `Groundhog has no route for ${ctx.method} ${ctx.url.pathname}. Provider APIs live under /groundmail, /sendgrid, /postmark, /mailgun, /resend and /ses; the testing API under /api.`)
      }
      ctx.params = match.params
      const result = await match.route.handler(ctx)
      if (result) ctx.send(result)
    } catch (error) {
      if (error instanceof HttpError) return ctx.send({ status: error.status, body: { error: error.message } })
      log(`error on ${ctx.method} ${ctx.url.pathname}: ${(error as Error).stack ?? error}`)
      ctx.send({ status: 500, body: { error: (error as Error).message } })
    }
  }

  // ---- Listen --------------------------------------------------------------
  const host = options.host ?? 'localhost'
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host]
  const httpServers: Server[] = []
  const smtpServers: SMTPServer[] = []

  const listenHttp = (port: number, address: string, optional: boolean) =>
    new Promise<number | null>((resolve, reject) => {
      const server = createServer((req, res) => void handle(req, res))
      server.keepAliveTimeout = 5000
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (optional && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) return resolve(null)
        reject(error)
      })
      server.listen(port, address, () => {
        httpServers.push(server)
        resolve((server.address() as AddressInfo).port)
      })
    })

  const listenSmtp = (port: number, address: string, optional: boolean) =>
    new Promise<number | null>((resolve, reject) => {
      const server = createSmtpServer({ faults, ingest, onError: (error) => log(`smtp error: ${error.message}`) })
      const net = (server as unknown as { server: import('node:net').Server }).server
      net.once('error', (error: NodeJS.ErrnoException) => {
        if (optional && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) return resolve(null)
        reject(error)
      })
      server.listen(port, address, () => {
        smtpServers.push(server)
        resolve((net.address() as AddressInfo).port)
      })
    })

  let httpPort = options.httpPort ?? 3025
  let smtpPort = options.smtpPort ?? 1025
  try {
    for (const [index, address] of hosts.entries()) {
      const port = await listenHttp(httpPort, address, index > 0)
      if (port != null) httpPort = port
    }
    if (options.smtp !== false) {
      for (const [index, address] of hosts.entries()) {
        const port = await listenSmtp(smtpPort, address, index > 0)
        if (port != null) smtpPort = port
      }
    }
  } catch (error) {
    for (const server of httpServers) server.close()
    for (const server of smtpServers) server.close(() => {})
    const e = error as NodeJS.ErrnoException
    if (e.code === 'EADDRINUSE') {
      throw new Error(`Port ${(e as unknown as { port?: number }).port ?? ''} is already in use. Is Groundhog (or another local inbox) already running? Pick other ports with --http-port and --smtp-port.`)
    }
    throw error
  }

  const displayHost = host === 'localhost' || host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host
  baseUrl = `http://${displayHost}:${httpPort}`

  return {
    url: baseUrl,
    smtpPort,
    httpPort,
    host,
    store,
    faults,
    webhooks,
    account,
    async close() {
      for (const client of sse) client.res.end()
      sse.clear()
      store.saveNow()
      await Promise.all([
        ...httpServers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
              server.closeAllConnections?.()
            }),
        ),
        ...smtpServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      ])
    },
  }
}
