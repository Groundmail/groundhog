import { randomBytes, randomUUID } from 'node:crypto'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type Mail from 'nodemailer/lib/mailer/index.js'
import { extractCode, extractLinks } from './extract.js'
import type { Address, Provider, StoredEmail } from './types.js'

export function newId(prefix = 'gh'): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`
}

export type AddressInput = string | { email?: string; address?: string; name?: string | null } | null | undefined

/** "Ada <ada@example.com>", "ada@example.com", { email, name } or { address, name } → Address. */
export function toAddress(input: AddressInput): Address | null {
  if (!input) return null
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return null
    const match = trimmed.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
    if (match) return { name: match[1].trim(), address: match[2].trim() }
    return { name: '', address: trimmed }
  }
  const address = (input.email ?? input.address ?? '').trim()
  if (!address) return null
  return { name: (input.name ?? '').trim(), address }
}

/** Accepts one address, an array, or a comma-separated string. */
export function toAddressList(input: unknown): Address[] {
  if (input == null || input === '') return []
  if (Array.isArray(input)) return input.flatMap((item) => toAddressList(item))
  if (typeof input === 'string') {
    return splitAddresses(input)
      .map((part) => toAddress(part))
      .filter((a): a is Address => Boolean(a))
  }
  const one = toAddress(input as AddressInput)
  return one ? [one] : []
}

function splitAddresses(value: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  let inAngle = false
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes
    if (ch === '<') inAngle = true
    if (ch === '>') inAngle = false
    if ((ch === ',' || ch === ';') && !inQuotes && !inAngle) {
      if (current.trim()) out.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export function formatAddress(address: Address): string {
  return address.name ? `"${address.name.replace(/"/g, '')}" <${address.address}>` : address.address
}

export type AttachmentInput = {
  filename?: string
  content: Buffer | string
  contentType?: string
  cid?: string
  encoding?: 'base64' | 'utf8'
}

/** The parts an HTTP send API hands us. Every provider route maps its own body onto this. */
export type ComposeInput = {
  from: Address | null
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  replyTo?: Address[]
  subject?: string
  html?: string | null
  text?: string | null
  headers?: Record<string, string>
  attachments?: AttachmentInput[]
  tags?: string[]
  metadata?: Record<string, string>
}

/** Build the RFC 5322 source for an API send, so every email has a real Source tab. */
export async function compose(input: ComposeInput, messageId: string): Promise<Buffer> {
  const mail: Mail.Options = {
    from: input.from ? formatAddress(input.from) : undefined,
    to: input.to.map(formatAddress),
    cc: input.cc?.map(formatAddress),
    bcc: input.bcc?.map(formatAddress),
    replyTo: input.replyTo?.map(formatAddress),
    subject: input.subject ?? '',
    html: input.html ?? undefined,
    text: input.text ?? undefined,
    headers: input.headers,
    messageId: `<${messageId}@groundhog.local>`,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
      cid: attachment.cid,
      encoding: typeof attachment.content === 'string' ? (attachment.encoding ?? 'base64') : undefined,
    })),
  }
  const node = new MailComposer(mail).compile()
  ;(node as unknown as { keepBcc: boolean }).keepBcc = true
  return node.build()
}

function addressList(value: AddressObject | AddressObject[] | undefined): Address[] {
  if (!value) return []
  const objects = Array.isArray(value) ? value : [value]
  const out: Address[] = []
  for (const object of objects) {
    for (const entry of object.value) {
      if (entry.address) out.push({ name: entry.name ?? '', address: entry.address })
      for (const member of entry.group ?? []) {
        if (member.address) out.push({ name: member.name ?? '', address: member.address })
      }
    }
  }
  return out
}

function headerPairs(parsed: ParsedMail): Array<[string, string]> {
  return parsed.headerLines.map((line) => {
    const colon = line.line.indexOf(':')
    const name = colon >= 0 ? line.line.slice(0, colon) : line.key
    const value = colon >= 0 ? line.line.slice(colon + 1).replace(/\r?\n[ \t]+/g, ' ').trim() : ''
    return [name, value] as [string, string]
  })
}

export type IngestMeta = {
  via: Provider
  providerMessageId?: string
  /** Envelope recipients (SMTP RCPT TO, or API bcc) that aren't in the headers. */
  envelopeTo?: Address[]
  bcc?: Address[]
  tags?: string[]
  metadata?: Record<string, string>
  id?: string
  createdAt?: string
}

/** Parse raw source into the stored shape. */
export async function parseEmail(raw: Buffer, meta: IngestMeta): Promise<StoredEmail> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true })
  const id = meta.id ?? newId()
  const to = addressList(parsed.to)
  const cc = addressList(parsed.cc)
  let bcc = meta.bcc ?? addressList(parsed.bcc)
  if (meta.envelopeTo?.length) {
    const visible = new Set([...to, ...cc, ...bcc].map((a) => a.address.toLowerCase()))
    bcc = [...bcc, ...meta.envelopeTo.filter((a) => !visible.has(a.address.toLowerCase()))]
  }
  const attachmentContent = new Map<string, Buffer>()
  const attachments = parsed.attachments.map((attachment, index) => {
    const attachmentId = `${index}`
    attachmentContent.set(attachmentId, attachment.content)
    return {
      id: attachmentId,
      filename: attachment.filename ?? `attachment-${index + 1}`,
      contentType: attachment.contentType,
      size: attachment.size ?? attachment.content.length,
      contentId: attachment.contentId?.replace(/^<|>$/g, ''),
      inline: attachment.contentDisposition === 'inline' || Boolean(attachment.related),
    }
  })
  const html = typeof parsed.html === 'string' ? parsed.html : null
  const text = parsed.text ?? null
  const subject = parsed.subject ?? ''
  return {
    id,
    providerMessageId: meta.providerMessageId ?? parsed.messageId?.replace(/^<|>$/g, '') ?? id,
    via: meta.via,
    from: addressList(parsed.from)[0] ?? null,
    to,
    cc,
    bcc,
    replyTo: addressList(parsed.replyTo),
    subject,
    html,
    text,
    headers: headerPairs(parsed),
    attachments,
    tags: meta.tags ?? [],
    metadata: meta.metadata ?? {},
    createdAt: meta.createdAt ?? new Date().toISOString(),
    size: raw.length,
    code: extractCode({ html, text, subject }),
    links: extractLinks({ html, text }),
    raw,
    attachmentContent,
  }
}

/** Compose and parse an API send in one step. */
export async function ingestApiSend(input: ComposeInput, meta: IngestMeta): Promise<StoredEmail> {
  const id = meta.id ?? newId()
  const raw = await compose(input, id)
  return parseEmail(raw, {
    ...meta,
    id,
    bcc: input.bcc ?? [],
    tags: meta.tags ?? input.tags,
    metadata: meta.metadata ?? input.metadata,
  })
}

export function uuid(): string {
  return randomUUID()
}
