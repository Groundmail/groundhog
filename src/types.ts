export type Provider = 'smtp' | 'groundmail' | 'resend' | 'sendgrid' | 'postmark' | 'mailgun' | 'ses'

export const PROVIDERS: Provider[] = ['smtp', 'groundmail', 'sendgrid', 'postmark', 'mailgun', 'resend', 'ses']

export const PROVIDER_LABELS: Record<Provider, string> = {
  smtp: 'SMTP',
  groundmail: 'Groundmail API',
  sendgrid: 'SendGrid API',
  postmark: 'Postmark API',
  mailgun: 'Mailgun API',
  resend: 'Resend API',
  ses: 'Amazon SES API',
}

export type Address = { name: string; address: string }

export type AttachmentInfo = {
  id: string
  filename: string
  contentType: string
  size: number
  contentId?: string
  inline: boolean
}

/** An email Groundhog caught, as the JSON API returns it. */
export type Email = {
  id: string
  /** The id the sending API returned to the app (a Postmark MessageID, a SendGrid X-Message-Id, …). */
  providerMessageId: string
  via: Provider
  from: Address | null
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  subject: string
  html: string | null
  text: string | null
  headers: Array<[string, string]>
  attachments: AttachmentInfo[]
  tags: string[]
  metadata: Record<string, string>
  createdAt: string
  size: number
  /** A one-time code found in the email, if any. */
  code: string | null
  /** Every http(s) link in the email, in order. */
  links: string[]
}

export type StoredEmail = Email & {
  raw: Buffer
  attachmentContent: Map<string, Buffer>
}

export type WebhookEvent = 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked'

export const WEBHOOK_EVENTS: WebhookEvent[] = ['delivered', 'bounced', 'complained', 'opened', 'clicked']

export type FaultKind = 'rate_limit' | 'invalid_recipient' | 'unauthorized' | 'outage' | 'timeout'

export const FAULT_KINDS: FaultKind[] = ['rate_limit', 'invalid_recipient', 'unauthorized', 'outage', 'timeout']
