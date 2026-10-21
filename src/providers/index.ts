import { groundmail } from './groundmail.js'
import { mailgun } from './mailgun.js'
import { postmark } from './postmark.js'
import { resend } from './resend.js'
import { sendgrid } from './sendgrid.js'
import { ses } from './ses.js'
import type { ProviderModule } from './types.js'

export type WebhookFormat = 'groundmail' | 'sendgrid' | 'postmark' | 'mailgun' | 'resend' | 'ses'

export const WEBHOOK_FORMATS: WebhookFormat[] = ['groundmail', 'sendgrid', 'postmark', 'mailgun', 'resend', 'ses']

export const HTTP_PROVIDERS: ProviderModule[] = [groundmail, resend, sendgrid, postmark, mailgun, ses]

export const PROVIDER_MODULES: Record<WebhookFormat, ProviderModule> = { groundmail, sendgrid, postmark, mailgun, resend, ses }

export { groundmail, mailgun, postmark, resend, sendgrid, ses }
