/**
 * Helpers for tests (Playwright, Vitest, Jest…) that talk to a running Groundhog.
 *
 *   const email = await waitForEmail({ to: 'ada@example.com' })
 *   email.code      // "482913"
 *   email.links[0]  // "http://localhost:3000/verify?token=…"
 */
import { extractCode, extractLinks, pickLink } from './extract.js'
import type { Email, FaultKind, WebhookEvent } from './types.js'

export type ClientOptions = {
  /** Groundhog's HTTP URL. Default: GROUNDHOG_URL, then http://localhost:3025. */
  baseUrl?: string
  fetch?: typeof fetch
}

export type EmailQuery = {
  to?: string
  from?: string
  subject?: string
  /** Free-text search over subject, addresses, text and code. */
  q?: string
  via?: Email['via']
  /** Only emails caught at or after this time. */
  since?: Date | string
}

export type WaitOptions = EmailQuery & ClientOptions & {
  /** Milliseconds. Default 30 000. */
  timeout?: number
}

function base(options: ClientOptions = {}): string {
  const fromEnv = typeof process !== 'undefined' ? process.env?.GROUNDHOG_URL : undefined
  return (options.baseUrl ?? fromEnv ?? 'http://localhost:3025').replace(/\/+$/, '')
}

function queryString(query: EmailQuery & { timeout?: number; limit?: number }): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (!['to', 'from', 'subject', 'q', 'via', 'since', 'timeout', 'limit'].includes(key)) continue
    params.set(key, value instanceof Date ? value.toISOString() : String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function request<T>(path: string, init: RequestInit & ClientOptions = {}): Promise<{ status: number; body: T }> {
  const doFetch = init.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(`${base(init)}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (error) {
    throw new Error(`Could not reach Groundhog at ${base(init)}. Start it with \`npx @groundmail/groundhog\`. (${(error as Error).message})`)
  }
  const body = (await response.json().catch(() => ({}))) as T
  return { status: response.status, body }
}

/** Wait for an email that matches (one already caught counts). Throws after `timeout`. */
export async function waitForEmail(options: WaitOptions = {}): Promise<Email> {
  const timeout = options.timeout ?? 30_000
  const { status, body } = await request<Email & { error?: string }>(`/api/wait${queryString({ ...options, timeout })}`, options)
  if (status === 200) return body
  const what = [options.to && `to ${options.to}`, options.subject && `subject "${options.subject}"`].filter(Boolean).join(', ')
  throw new Error(`No email${what ? ` ${what}` : ''} arrived within ${timeout} ms${body.error && status !== 408 ? `: ${body.error}` : ''}`)
}

export async function listEmails(query: EmailQuery & ClientOptions & { limit?: number } = {}): Promise<Email[]> {
  const { body } = await request<{ data: Email[] }>(`/api/emails${queryString(query)}`, query)
  return body.data ?? []
}

export async function getEmail(id: string, options: ClientOptions = {}): Promise<Email> {
  const { status, body } = await request<Email & { error?: string }>(`/api/emails/${encodeURIComponent(id)}`, options)
  if (status !== 200) throw new Error(body.error ?? `Email ${id} not found`)
  return body
}

export async function clearEmails(options: ClientOptions = {}): Promise<void> {
  await request(`/api/emails`, { ...options, method: 'DELETE' })
}

/** Make the next `next` sends fail. `status`: 429, 422, 401, '5xx' or 'timeout'. */
export async function simulateFault(options: ClientOptions & { status: 429 | 422 | 401 | 500 | 503 | '5xx' | 'timeout' | FaultKind; next?: number; timeoutMs?: number }): Promise<void> {
  const { status, body } = await request<{ error?: string }>(`/api/faults`, {
    ...options,
    method: 'POST',
    body: JSON.stringify({ status: options.status, next: options.next ?? 1, timeoutMs: options.timeoutMs }),
  })
  if (status !== 200) throw new Error(body.error ?? 'Could not set the fault')
}

export async function clearFaults(options: ClientOptions = {}): Promise<void> {
  await request(`/api/faults`, { ...options, method: 'DELETE' })
}

/** Fire a simulated webhook for a caught email at the configured (or given) URL. */
export async function fireWebhook(options: ClientOptions & { id: string; event: WebhookEvent; url?: string }): Promise<{ status: number | null; ok: boolean; error: string | null }> {
  const { status, body } = await request<{ status: number | null; ok: boolean; error: string | null }>(`/api/emails/${encodeURIComponent(options.id)}/webhooks`, {
    ...options,
    method: 'POST',
    body: JSON.stringify({ event: options.event, url: options.url }),
  })
  if (status !== 200) throw new Error((body as unknown as { error?: string }).error ?? 'Could not fire the webhook')
  return body
}

/** The first link in the email (skipping unsubscribe/asset links), or the first containing `contains`. */
export function extractLink(email: Pick<Email, 'html' | 'text'> | string, contains?: string): string | null {
  return pickLink(extractLinks(email), contains)
}

export { extractCode, extractLinks }
