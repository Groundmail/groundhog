/** "Send to my real inbox" against a fake Groundmail API (device flow + send). */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configDir } from '../src/groundmail-account.js'
import type { Groundhog } from '../src/index.js'
import { json, start } from './helpers.js'

let gh: Groundhog
let fake: Server
const calls: Array<{ path: string; auth?: string; body: any }> = []
let approved = false

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      calls.push({ path: req.url!, auth: req.headers.authorization, body })
      const send = (status: number, payload: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload))
      if (req.url === '/oauth/device_authorization') {
        return send(200, { device_code: 'dev_1', user_code: 'ABCD-EFGH', verification_uri: 'https://app.test/cli-login', verification_uri_complete: 'https://app.test/cli-login?code=ABCD-EFGH', expires_in: 600, interval: 1 })
      }
      if (req.url === '/oauth/token' && body.grant_type.endsWith('device_code')) {
        if (!approved) return send(400, { error: 'authorization_pending' })
        return send(200, { access_token: 'gm_oat_1', refresh_token: 'gm_ort_1', expires_in: 3600, user: { email: 'dev@company.test' }, workspace: { name: 'Acme' } })
      }
      if (req.url === '/emails') {
        if (body.to[0] !== 'dev@company.test') return send(403, { error: { message: 'Sandbox sends only go to your own account email.', code: 'forbidden' } })
        return send(200, { id: 'msg_real_1', status: 'sent' })
      }
      if (req.url === '/oauth/revoke') return send(200, {})
      send(404, {})
    })
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  gh = await start({ groundmailApiUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` })
})
afterAll(async () => {
  await gh.close()
  fake.close()
})

describe('send to my real inbox', () => {
  it('connects with the device flow, sends a copy from the sandbox sender, disconnects', async () => {
    expect((await json(gh, '/api/groundmail')).body.connected).toBe(false)
    const started = await json(gh, '/api/groundmail/connect', { method: 'POST' })
    expect(started.body.pending.userCode).toBe('ABCD-EFGH')
    expect(started.body.pending.url).toContain('utm_source=groundhog')
    expect(calls[0].body).toMatchObject({ client_id: 'groundhog', scope: 'emails:send account:read' })

    approved = true
    await new Promise((r) => setTimeout(r, 1500))
    const status = await json(gh, '/api/groundmail')
    expect(status.body).toMatchObject({ connected: true, email: 'dev@company.test', pending: null })
    const file = join(configDir(), 'groundmail.json')
    expect(existsSync(file)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)

    const sample = await json(gh, '/api/emails/sample', { method: 'POST' })
    const sent = await json(gh, `/api/emails/${sample.body.id}/send-to-inbox`, { method: 'POST', body: '{}' })
    expect(sent.body).toEqual({ id: 'msg_real_1', to: 'dev@company.test' })
    const sendCall = calls.find((c) => c.path === '/emails')!
    expect(sendCall.auth).toBe('Bearer gm_oat_1')
    expect(sendCall.body).toMatchObject({ from: 'Groundhog <noreply@mail.groundmail.dev>', to: ['dev@company.test'], subject: 'Your Acme sign-in code' })

    const refused = await json(gh, `/api/emails/${sample.body.id}/send-to-inbox`, { method: 'POST', body: JSON.stringify({ to: 'someone@else.test' }) })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('own account email')

    await json(gh, '/api/groundmail/disconnect', { method: 'POST' })
    expect(existsSync(file)).toBe(false)
    expect(calls.some((c) => c.path === '/oauth/revoke' && c.body.token === 'gm_ort_1')).toBe(true)
  })
})
