export {
  clearEmails,
  clearFaults,
  extractCode,
  extractLink,
  extractLinks,
  fireWebhook,
  getEmail,
  listEmails,
  simulateFault,
  waitForEmail,
  type ClientOptions,
  type EmailQuery,
  type WaitOptions,
} from './client.js'
export { startGroundhog, VERSION, type Groundhog, type GroundhogOptions } from './server.js'
export type { Address, AttachmentInfo, Email, FaultKind, Provider, WebhookEvent } from './types.js'
