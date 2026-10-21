import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGroundhog, type Groundhog, type GroundhogOptions } from '../src/index.js'

export async function start(options: GroundhogOptions = {}): Promise<Groundhog> {
  process.env.GROUNDHOG_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'groundhog-test-'))
  return startGroundhog({ httpPort: 0, smtpPort: 0, host: '127.0.0.1', faultTimeoutMs: 200, ...options })
}

export async function json<T = any>(gh: Groundhog, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${gh.url}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T }
}
