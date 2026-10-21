/**
 * Local signing keys for simulated webhooks. They are fixed, published dev keys so
 * an app's verification code can be configured once and keep working across restarts.
 * Never use them for anything but local development.
 */
import { createECDH, createHash, createHmac, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto'

export type WebhookSecrets = {
  /** Groundmail: `Groundmail-Signature: t=…,v1=…` (HMAC-SHA256 over `t.body`). */
  groundmail: string
  /** Resend (Svix): `whsec_…`; HMAC-SHA256 over `id.timestamp.body` with the base64 part as key. */
  resend: string
  /** Mailgun: HTTP webhook signing key; HMAC-SHA256 over `timestamp + token`. */
  mailgun: string
}

export const DEFAULT_SECRETS: WebhookSecrets = {
  groundmail: 'whsec_groundhog_local_dev_secret',
  resend: `whsec_${Buffer.from('groundhog-local-dev-webhook-key!').toString('base64')}`,
  mailgun: 'groundhog-local-mailgun-signing-key',
}

export function groundmailSignature(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

export function svixSignature(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

export function mailgunSignature(signingKey: string, timestamp: string, token: string): string {
  return createHmac('sha256', signingKey).update(`${timestamp}${token}`).digest('hex')
}

let sendgridKey: { privateKey: KeyObject; publicKeyBase64: string } | null = null

/** SendGrid signs its Event Webhook with ECDSA P-256; this is Groundhog's fixed local key pair. */
export function sendgridKeyPair(): { privateKey: KeyObject; publicKeyBase64: string } {
  if (sendgridKey) return sendgridKey
  const d = createHash('sha256').update('groundhog-local-sendgrid-event-webhook-key').digest()
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  const pub = ecdh.getPublicKey()
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: d.toString('base64url'),
    x: pub.subarray(1, 33).toString('base64url'),
    y: pub.subarray(33, 65).toString('base64url'),
  }
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' })
  const publicKeyBase64 = (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
  sendgridKey = { privateKey, publicKeyBase64 }
  return sendgridKey
}

/** `X-Twilio-Email-Event-Webhook-Signature`: base64 DER ECDSA-SHA256 over `timestamp + body`. */
export function sendgridSignature(timestamp: string, body: string): string {
  return cryptoSign('sha256', Buffer.from(timestamp + body), sendgridKeyPair().privateKey).toString('base64')
}
