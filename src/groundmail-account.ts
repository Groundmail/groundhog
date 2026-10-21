/**
 * "Send to my real inbox": a one-time Groundmail sign-in (OAuth device flow, like
 * `groundmail login`), then copies of caught emails go out through Groundmail's
 * sandbox sender, which only delivers to the account's own address.
 */
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { StoredEmail } from './types.js'

export const OAUTH_CLIENT_ID = 'groundhog'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const UTM = 'utm_source=groundhog&utm_medium=app'

export function withUtm(url: string, campaign: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${UTM}&utm_campaign=${campaign}`
}

type Saved = {
  apiUrl: string
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  email: string | null
  workspace: string | null
  savedAt: string
}

type Pending = { deviceCode: string; userCode: string; url: string; interval: number; expiresAt: number }

export type AccountStatus = {
  connected: boolean
  email: string | null
  workspace: string | null
  pending: { userCode: string; url: string; expiresAt: string } | null
  error: string | null
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GROUNDHOG_CONFIG_DIR) return env.GROUNDHOG_CONFIG_DIR
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'groundhog')
}

async function post(url: string, body: Record<string, unknown>, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'groundhog', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, body: json }
}

function apiError(body: Record<string, unknown>, fallback: string): string {
  const error = body.error
  if (error && typeof error === 'object') {
    const e = error as { message?: string; hint?: string }
    return [e.message, e.hint].filter(Boolean).join(' ') || fallback
  }
  if (typeof body.error_description === 'string') return body.error_description
  if (typeof error === 'string') return [error, body.hint].filter(Boolean).join(' ')
  return fallback
}

export class GroundmailAccount extends EventEmitter {
  private pending: Pending | null = null
  private lastError: string | null = null
  private polling = false

  constructor(
    private readonly options: { apiUrl?: string; from?: string; env?: NodeJS.ProcessEnv; openBrowser?: (url: string) => void } = {},
  ) {
    super()
  }

  get apiUrl(): string {
    return (this.options.apiUrl || this.options.env?.GROUNDMAIL_API_URL || 'https://api.groundmail.dev').replace(/\/+$/, '')
  }

  get from(): string {
    return this.options.from || 'Groundhog <noreply@mail.groundmail.dev>'
  }

  private get file(): string {
    return join(configDir(this.options.env), 'groundmail.json')
  }

  private load(): Saved | null {
    try {
      if (!existsSync(this.file)) return null
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Saved
      return saved.apiUrl === this.apiUrl ? saved : null
    } catch {
      return null
    }
  }

  private save(saved: Saved): void {
    mkdirSync(configDir(this.options.env), { recursive: true })
    writeFileSync(this.file, JSON.stringify(saved, null, 2), { mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Best effort on filesystems without modes.
    }
  }

  status(): AccountStatus {
    const saved = this.load()
    return {
      connected: Boolean(saved),
      email: saved?.email ?? null,
      workspace: saved?.workspace ?? null,
      pending: this.pending ? { userCode: this.pending.userCode, url: this.pending.url, expiresAt: new Date(this.pending.expiresAt).toISOString() } : null,
      error: this.lastError,
    }
  }

  /** Start the browser sign-in. Resolves with the link and code; finishes in the background. */
  async connect(): Promise<AccountStatus> {
    if (this.load()) return this.status()
    if (this.pending && this.pending.expiresAt > Date.now() + 5000) return this.status()
    this.lastError = null
    const start = await post(`${this.apiUrl}/oauth/device_authorization`, {
      client_id: OAUTH_CLIENT_ID,
      scope: 'emails:send account:read',
      device_name: `Groundhog on ${hostname().slice(0, 60) || 'this computer'}`,
    })
    const body = start.body
    const url = typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : body.verification_uri
    if (start.status >= 400 || typeof body.device_code !== 'string' || typeof url !== 'string') {
      this.lastError = apiError(body, 'Could not start the Groundmail sign-in.')
      throw new Error(this.lastError)
    }
    this.pending = {
      deviceCode: body.device_code,
      userCode: String(body.user_code ?? ''),
      url: withUtm(url, 'real_inbox'),
      interval: Math.max(1, Number(body.interval) || 5),
      expiresAt: Date.now() + (Number(body.expires_in) || 600) * 1000,
    }
    this.options.openBrowser?.(this.pending.url)
    void this.poll()
    this.emit('change', this.status())
    return this.status()
  }

  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      while (this.pending && this.pending.expiresAt > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, this.pending!.interval * 1000).unref?.())
        const pending = this.pending
        if (!pending) break
        let result: { status: number; body: Record<string, unknown> }
        try {
          result = await post(`${this.apiUrl}/oauth/token`, { grant_type: DEVICE_GRANT, device_code: pending.deviceCode, client_id: OAUTH_CLIENT_ID })
        } catch {
          continue
        }
        if (result.status < 300 && typeof result.body.access_token === 'string') {
          this.storeTokens(result.body)
          this.pending = null
          this.emit('change', this.status())
          return
        }
        const code = String(result.body.error ?? '')
        if (code === 'authorization_pending') continue
        if (code === 'slow_down') {
          pending.interval += 5
          continue
        }
        this.lastError = code === 'access_denied' ? 'The sign-in was canceled.' : apiError(result.body, 'The sign-in expired. Try again.')
        this.pending = null
        this.emit('change', this.status())
        return
      }
      if (this.pending) {
        this.pending = null
        this.lastError = 'The sign-in expired. Try again.'
        this.emit('change', this.status())
      }
    } finally {
      this.polling = false
    }
  }

  private storeTokens(body: Record<string, unknown>, previous?: Saved): Saved {
    const user = (body.user ?? {}) as { email?: string }
    const workspace = (body.workspace ?? {}) as { name?: string }
    const saved: Saved = {
      apiUrl: this.apiUrl,
      accessToken: String(body.access_token),
      accessTokenExpiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : (previous?.refreshToken ?? ''),
      email: user.email ?? previous?.email ?? null,
      workspace: workspace.name ?? previous?.workspace ?? null,
      savedAt: new Date().toISOString(),
    }
    this.save(saved)
    return saved
  }

  private async accessToken(): Promise<string> {
    const saved = this.load()
    if (!saved) throw new Error('Connect Groundmail first.')
    if (saved.accessTokenExpiresAt > Date.now() + 60_000) return saved.accessToken
    const result = await post(`${this.apiUrl}/oauth/token`, { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: OAUTH_CLIENT_ID })
    if (result.status >= 300 || typeof result.body.access_token !== 'string') {
      if (result.status === 400 || result.status === 401) rmSync(this.file, { force: true })
      throw new Error(apiError(result.body, 'The Groundmail sign-in expired. Connect again.'))
    }
    return this.storeTokens(result.body, saved).accessToken
  }

  async disconnect(): Promise<AccountStatus> {
    const saved = this.load()
    this.pending = null
    if (saved?.refreshToken) {
      await post(`${this.apiUrl}/oauth/revoke`, { token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: OAUTH_CLIENT_ID }).catch(() => null)
    }
    rmSync(this.file, { force: true })
    this.emit('change', this.status())
    return this.status()
  }

  /** Send a copy of a caught email through Groundmail. */
  async sendCopy(email: StoredEmail, to?: string): Promise<{ id: string; to: string }> {
    const saved = this.load()
    const recipient = (to || saved?.email || '').trim()
    if (!recipient) throw new Error('Which address should get the copy?')
    const token = await this.accessToken()
    const attachments = email.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: email.attachmentContent.get(attachment.id)?.toString('base64') ?? '',
      content_type: attachment.contentType,
    }))
    const result = await post(
      `${this.apiUrl}/emails`,
      {
        from: this.from,
        to: [recipient],
        subject: email.subject || '(no subject)',
        ...(email.html ? { html: email.html } : {}),
        ...(email.text ? { text: email.text } : {}),
        ...(!email.html && !email.text ? { text: '(This email had no body.)' } : {}),
        ...(attachments.length ? { attachments } : {}),
        headers: { 'X-Groundhog-Copy-Of': email.id },
      },
      token,
    )
    if (result.status >= 300) throw new Error(apiError(result.body, `Groundmail answered ${result.status}.`))
    return { id: String(result.body.id ?? ''), to: recipient }
  }
}
