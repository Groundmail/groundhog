import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseEmail } from './mime.js'
import type { Email, StoredEmail } from './types.js'

export type EmailFilter = {
  to?: string
  from?: string
  subject?: string
  q?: string
  via?: string
  since?: string | Date
}

export function publicEmail(email: StoredEmail): Email {
  const { raw: _raw, attachmentContent: _content, ...rest } = email
  return rest
}

function lower(value: string | undefined | null): string {
  return (value ?? '').toLowerCase()
}

export function matches(email: Email, filter: EmailFilter): boolean {
  if (filter.to) {
    const want = lower(filter.to)
    const all = [...email.to, ...email.cc, ...email.bcc].map((a) => lower(a.address))
    if (!all.some((address) => address === want || (want.startsWith('@') && address.endsWith(want)) || (!want.includes('@') && address.includes(want)))) return false
  }
  if (filter.from && !lower(email.from?.address).includes(lower(filter.from))) return false
  if (filter.subject && !lower(email.subject).includes(lower(filter.subject))) return false
  if (filter.via && email.via !== filter.via) return false
  if (filter.since) {
    const since = new Date(filter.since).getTime()
    if (!Number.isNaN(since) && new Date(email.createdAt).getTime() < since) return false
  }
  if (filter.q) {
    const q = lower(filter.q)
    const hay = [
      email.subject,
      email.from?.address,
      email.from?.name,
      ...email.to.map((a) => `${a.name} ${a.address}`),
      ...email.cc.map((a) => a.address),
      email.text,
      email.code,
    ]
      .map(lower)
      .join('\n')
    if (!hay.includes(q)) return false
  }
  return true
}

type Persisted = { version: 1; emails: Array<{ id: string; via: string; providerMessageId: string; createdAt: string; tags: string[]; metadata: Record<string, string>; bcc: Email['bcc']; raw: string }> }

/** In-memory inbox, newest first. Optionally saved to a JSON file. */
export class EmailStore extends EventEmitter {
  private emails: StoredEmail[] = []
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: { max?: number; file?: string } = {}) {
    super()
    this.setMaxListeners(0)
  }

  get max(): number {
    return this.options.max ?? 1000
  }

  async load(): Promise<void> {
    const file = this.options.file
    if (!file || !existsSync(file)) return
    const data = JSON.parse(readFileSync(file, 'utf8')) as Persisted
    const loaded: StoredEmail[] = []
    for (const entry of data.emails ?? []) {
      loaded.push(
        await parseEmail(Buffer.from(entry.raw, 'base64'), {
          id: entry.id,
          via: entry.via as Email['via'],
          providerMessageId: entry.providerMessageId,
          createdAt: entry.createdAt,
          tags: entry.tags,
          metadata: entry.metadata,
          bcc: entry.bcc,
        }),
      )
    }
    this.emails = loaded
  }

  private scheduleSave(): void {
    const file = this.options.file
    if (!file) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 200)
    this.saveTimer.unref?.()
  }

  saveNow(): void {
    const file = this.options.file
    if (!file) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const data: Persisted = {
      version: 1,
      emails: this.emails.map((email) => ({
        id: email.id,
        via: email.via,
        providerMessageId: email.providerMessageId,
        createdAt: email.createdAt,
        tags: email.tags,
        metadata: email.metadata,
        bcc: email.bcc,
        raw: email.raw.toString('base64'),
      })),
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(data))
    renameSync(`${file}.tmp`, file)
  }

  add(email: StoredEmail): StoredEmail {
    this.emails.unshift(email)
    if (this.emails.length > this.max) this.emails.length = this.max
    this.scheduleSave()
    this.emit('email', email)
    return email
  }

  list(filter: EmailFilter = {}, limit = 100): StoredEmail[] {
    return this.emails.filter((email) => matches(email, filter)).slice(0, limit)
  }

  count(): number {
    return this.emails.length
  }

  get(id: string): StoredEmail | undefined {
    return this.emails.find((email) => email.id === id || email.providerMessageId === id)
  }

  latest(filter: EmailFilter = {}): StoredEmail | undefined {
    return this.emails.find((email) => matches(email, filter))
  }

  delete(id: string): boolean {
    const before = this.emails.length
    this.emails = this.emails.filter((email) => email.id !== id)
    const removed = this.emails.length !== before
    if (removed) {
      this.scheduleSave()
      this.emit('delete', id)
    }
    return removed
  }

  clear(): void {
    this.emails = []
    this.scheduleSave()
    this.emit('clear')
  }

  /** Resolve with the first email (already caught after `since`, or arriving later) that matches. */
  waitFor(filter: EmailFilter, timeoutMs: number, signal?: AbortSignal): Promise<StoredEmail | null> {
    const existing = this.latest(filter)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const onEmail = (email: StoredEmail) => {
        if (!matches(email, filter)) return
        done(email)
      }
      const timer = setTimeout(() => done(null), Math.max(0, timeoutMs))
      const onAbort = () => done(null)
      const done = (email: StoredEmail | null) => {
        clearTimeout(timer)
        this.off('email', onEmail)
        signal?.removeEventListener('abort', onAbort)
        resolve(email)
      }
      this.on('email', onEmail)
      signal?.addEventListener('abort', onAbort)
    })
  }
}
