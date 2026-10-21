import type { HttpResult, RequestContext, Router } from '../http.js'
import type { WebhookSecrets } from '../signing.js'
import type { Email, FaultKind, Provider, StoredEmail, WebhookEvent } from '../types.js'

export type Hub = {
  /** Add a caught email to the inbox (fires the auto `delivered` webhook when that's on). */
  ingest(email: StoredEmail): StoredEmail
  get(id: string): StoredEmail | undefined
  /**
   * Apply failure mode to this send. Returns true when the request was answered
   * with a simulated failure (or dropped, for a timeout) and the route must stop.
   */
  guard(ctx: RequestContext, provider: ProviderModule): Promise<boolean>
}

export type WebhookRequest = {
  /** Event id, shown in the delivery log. */
  eventId: string
  headers: Record<string, string>
  body: string
}

export type WebhookContext = {
  secrets: WebhookSecrets
  /** Link used for `clicked` events. */
  link: string
  /** Groundhog's own base URL (for SNS cert links and such). */
  baseUrl: string
}

export type ProviderModule = {
  id: Exclude<Provider, 'smtp'> | 'smtp'
  /** The provider's own name for each event, shown on the webhook buttons. */
  eventNames: Record<WebhookEvent, string>
  register?(router: Router, hub: Hub): void
  /** The error response this provider returns for a simulated failure. */
  fail(kind: Exclude<FaultKind, 'timeout'>, ctx?: RequestContext): HttpResult
  webhook(event: WebhookEvent, email: Email, ctx: WebhookContext): WebhookRequest
}
