import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Groundmail } from 'groundmail'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMcpServer } from '../src/mcp.js'
import type { Groundhog } from '../src/index.js'
import { start } from './helpers.js'

let gh: Groundhog
let client: Client

beforeAll(async () => {
  gh = await start()
  const server = createMcpServer(gh.url)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
})
afterAll(async () => {
  await client.close()
  await gh.close()
})

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text
}

describe('MCP server', () => {
  it('lists the launch tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['get_code', 'get_email', 'get_link', 'list_emails', 'simulate_fault', 'wait_for_email'])
  })

  it('waits for an email, then gets its code and magic link', async () => {
    const waiting = client.callTool({ name: 'wait_for_email', arguments: { to: 'agent@example.com', timeout_seconds: 5 } })
    await new Promise((r) => setTimeout(r, 100))
    await new Groundmail('gm_test', { baseUrl: gh.url }).emails.send({
      from: 'Acme <auth@acme.test>',
      to: 'agent@example.com',
      subject: 'Your Acme sign-in code',
      html: '<p>Your code is 482913</p><a href="http://localhost:3000/magic?token=abc">Sign in</a>',
    })
    const waited = JSON.parse(textOf(await waiting))
    expect(waited).toMatchObject({ subject: 'Your Acme sign-in code', code: '482913' })
    expect(textOf(await client.callTool({ name: 'get_code', arguments: { to: 'agent@example.com' } }))).toBe('482913')
    expect(textOf(await client.callTool({ name: 'get_link', arguments: { to: 'agent@example.com' } }))).toBe('http://localhost:3000/magic?token=abc')
    const list = JSON.parse(textOf(await client.callTool({ name: 'list_emails', arguments: {} })))
    expect(list[0].id).toBe(waited.id)
    expect(JSON.parse(textOf(await client.callTool({ name: 'get_email', arguments: { id: waited.id } }))).text).toContain('482913')
  })

  it('reports a timeout as a tool error', async () => {
    const result = await client.callTool({ name: 'wait_for_email', arguments: { to: 'never@example.com', timeout_seconds: 1 } })
    expect(result.isError).toBe(true)
  })

  it('simulate_fault turns on failure mode', async () => {
    await client.callTool({ name: 'simulate_fault', arguments: { status: '429', next: 2 } })
    expect(gh.faults.get()).toMatchObject({ kind: 'rate_limit', remaining: 2 })
    await client.callTool({ name: 'simulate_fault', arguments: { status: '429', next: 0 } })
    expect(gh.faults.get()).toMatchObject({ kind: null, remaining: 0 })
  })
})
