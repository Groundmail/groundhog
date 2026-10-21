/** The built CLI, as `npx @groundmail/groundhog` and `… mcp` run it. Needs `npm run build` first. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Groundmail } from 'groundmail'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Groundhog } from '../src/index.js'
import { start } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const built = existsSync(CLI)

describe.skipIf(!built)('CLI', () => {
  it('prints help and version', () => {
    expect(execFileSync('node', [CLI, '--help'], { encoding: 'utf8' })).toContain('npx @groundmail/groundhog mcp')
    expect(execFileSync('node', [CLI, '--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe.skipIf(!built)('groundhog mcp over stdio', () => {
  let gh: Groundhog
  let client: Client

  beforeAll(async () => {
    gh = await start()
    client = new Client({ name: 'stdio-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: 'node', args: [CLI, 'mcp'], env: { ...process.env, GROUNDHOG_URL: gh.url } as Record<string, string> }))
  })
  afterAll(async () => {
    await client?.close()
    await gh.close()
  })

  it('returns the latest email and its magic link', async () => {
    await new Groundmail('gm_test', { baseUrl: gh.url }).emails.send({
      from: 'a@acme.test',
      to: 'stdio@example.com',
      subject: 'Sign in',
      html: '<a href="http://localhost:3000/magic?token=xyz">Sign in</a>',
    })
    const result = await client.callTool({ name: 'get_link', arguments: { to: 'stdio@example.com' } })
    expect((result.content as Array<{ text: string }>)[0].text).toBe('http://localhost:3000/magic?token=xyz')
  })
})
