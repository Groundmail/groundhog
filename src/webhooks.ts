import { EventEmitter } from 'node:events'
import { pickLink } from './extract.js'
import { newId } from './mime.js'
import { PROVIDER_MODULES, WEBHOOK_FORMATS, type WebhookFormat } from './providers/index.js'
import { DEFAULT_SECRETS, sendgridKeyPair, type WebhookSecrets } from './signing.js'
import type { Email, WebhookEvent } from './types.js'

export type WebhookSettings = {
  /** Where simulated events go. Null until the developer sets it. */
  url: string | null
  /** `auto` uses the format of the API the email came through (Groundmail's for SMTP). */
  format: 'auto' | WebhookFormat
  /** Fire `delivered` on its own for every caught email. */
  autoDelivered: boolean
  secrets: WebhookSecrets
}

export type WebhookDelivery = {
  id: string
  emailId: string
  event: WebhookEvent
  eventName: string
  format: WebhookFormat
  eventId: string
  url: string
  at: string
  durationMs: number
  /** The app's HTTP status, or null when the request failed. */
  status: number | null
  ok: boolean
  error: string | null
  requestHeaders: Record<string, string>
  requestBody: string
  responseBody: string
}

export function formatFor(email: Pick<Email, 'via'>, format: WebhookSettings['format']): WebhookFormat {
  if (format !== 'auto') return format
  return email.via === 'smtp' ? 'groundmail' : email.via
}

export function verificationKeys(settings: WebhookSettings) {
  return {
    groundmail: { header: 'Groundmail-Signature', secret: settings.secrets.groundmail },
    resend: { header: 'svix-signature', secret: settings.secrets.resend },
    mailgun: { field: 'signature.signature', signingKey: settings.secrets.mailgun },
    sendgrid: { header: 'X-Twilio-Email-Event-Webhook-Signature', publicKey: sendgridKeyPair().publicKeyBase64 },
    postmark: { note: 'Postmark webhooks are not signed. Protect the URL with basic auth or a secret path.' },
    ses: { note: 'SNS messages are signed with an AWS certificate that cannot be reproduced locally. Skip signature checks for local URLs.' },
  }
}

export class Webhooks extends EventEmitter {
  settings: WebhookSettings
  private log: WebhookDelivery[] = []

  constructor(
    initial: Partial<WebhookSettings> = {},
    private readonly baseUrl: () => string,
  ) {
    super()
    this.settings = {
      url: initial.url ?? null,
      format: initial.format ?? 'auto',
      autoDelivered: initial.autoDelivered ?? false,
      secrets: { ...DEFAULT_SECRETS, ...(initial.secrets ?? {}) },
    }
  }

  update(patch: Partial<Omit<WebhookSettings, 'secrets'>> & { secrets?: Partial<WebhookSecrets> }): WebhookSettings {
    if (patch.format && patch.format !== 'auto' && !WEBHOOK_FORMATS.includes(patch.format)) {
      throw new Error(`Unknown webhook format: ${patch.format}`)
    }
    if (patch.url !== undefined && patch.url !== null && patch.url !== '') {
      const parsed = new URL(patch.url)
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('The webhook URL must be http(s)')
    }
    this.settings = {
      url: patch.url === undefined ? this.settings.url : patch.url || null,
      format: patch.format ?? this.settings.format,
      autoDelivered: patch.autoDelivered ?? this.settings.autoDelivered,
      secrets: { ...this.settings.secrets, ...(patch.secrets ?? {}) },
    }
    this.emit('settings', this.settings)
    return this.settings
  }

  deliveries(emailId?: string): WebhookDelivery[] {
    return emailId ? this.log.filter((entry) => entry.emailId === emailId) : [...this.log]
  }

  clearLog(): void {
    this.log = []
  }

  async fire(email: Email, event: WebhookEvent, options: { url?: string; format?: WebhookSettings['format']; link?: string } = {}): Promise<WebhookDelivery> {
    const url = options.url || this.settings.url
    if (!url) throw new Error('Set a webhook URL first (PUT /api/webhooks { "url": "http://localhost:3000/webhooks/email" }).')
    const format = formatFor(email, options.format ?? this.settings.format)
    const module = PROVIDER_MODULES[format]
    const link = options.link ?? pickLink(email.links) ?? 'http://localhost/'
    const request = module.webhook(event, email, { secrets: this.settings.secrets, link, baseUrl: this.baseUrl() })
    const started = Date.now()
    const entry: WebhookDelivery = {
      id: newId('whd'),
      emailId: email.id,
      event,
      eventName: module.eventNames[event],
      format,
      eventId: request.eventId,
      url,
      at: new Date().toISOString(),
      durationMs: 0,
      status: null,
      ok: false,
      error: null,
      requestHeaders: { 'User-Agent': 'Groundhog-Webhooks', ...request.headers },
      requestBody: request.body,
      responseBody: '',
    }
    try {
      const response = await fetch(url, { method: 'POST', headers: entry.requestHeaders, body: request.body, signal: AbortSignal.timeout(10_000), redirect: 'manual' })
      entry.status = response.status
      entry.ok = response.status >= 200 && response.status < 300
      entry.responseBody = (await response.text().catch(() => '')).slice(0, 4000)
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause
      entry.error = cause?.code === 'ECONNREFUSED' ? `Nothing is listening at ${url}` : (cause?.message ?? (error as Error).message)
    }
    entry.durationMs = Date.now() - started
    this.log.unshift(entry)
    if (this.log.length > 500) this.log.length = 500
    this.emit('delivery', entry)
    return entry
  }
}
