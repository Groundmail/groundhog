import { randomBytes } from 'node:crypto'
import type { AttachmentInput } from '../mime.js'
import type { Email } from '../types.js'

/** Base64 string, a JSON-serialized Buffer (`{ type: 'Buffer', data }`), or a byte array → Buffer. */
export function decodeContent(content: unknown): Buffer {
  if (Buffer.isBuffer(content)) return content
  if (typeof content === 'string') return Buffer.from(content, 'base64')
  if (Array.isArray(content)) return Buffer.from(content as number[])
  if (content && typeof content === 'object' && Array.isArray((content as { data?: unknown }).data)) {
    return Buffer.from((content as { data: number[] }).data)
  }
  return Buffer.alloc(0)
}

export function attachment(filename: unknown, content: unknown, contentType?: unknown, cid?: unknown): AttachmentInput {
  return {
    filename: typeof filename === 'string' && filename ? filename : 'attachment',
    content: decodeContent(content),
    contentType: typeof contentType === 'string' && contentType ? contentType : undefined,
    cid: typeof cid === 'string' && cid ? cid : undefined,
  }
}

export function str(value: unknown): string | undefined {
  if (value == null) return undefined
  return typeof value === 'string' ? value : String(value)
}

/** `{ "X-Foo": "bar" }` or `[{ name, value }]` / `[{ Name, Value }]` → record. */
export function headerRecord(input: unknown): Record<string, string> | undefined {
  if (!input) return undefined
  const out: Record<string, string> = {}
  if (Array.isArray(input)) {
    for (const item of input as Array<Record<string, unknown>>) {
      const name = str(item.name ?? item.Name)
      const value = str(item.value ?? item.Value)
      if (name && value !== undefined) out[name] = value
    }
  } else if (typeof input === 'object') {
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      if (value !== undefined && value !== null) out[name] = String(value)
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

export function unixSeconds(date = new Date()): number {
  return Math.floor(date.getTime() / 1000)
}

export function recipient(email: Email): string {
  return email.to[0]?.address ?? email.cc[0]?.address ?? email.bcc[0]?.address ?? 'unknown@localhost'
}

export function allRecipients(email: Email): string[] {
  return [...email.to, ...email.cc, ...email.bcc].map((a) => a.address)
}

export function fromString(email: Email): string {
  if (!email.from) return ''
  return email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address
}

export function senderDomain(email: Email): string {
  return email.from?.address.split('@')[1] ?? 'localhost'
}
