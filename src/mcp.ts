/**
 * `groundhog mcp`: an MCP server (stdio) so coding agents can read the emails their
 * app sends: finish a sign-up with the code, follow a reset link, test failures.
 * Uses the Groundhog at GROUNDHOG_URL (default http://localhost:3025), and starts
 * one in this process when none is running.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getEmail, listEmails, simulateFault, waitForEmail } from './client.js'
import { pickLink } from './extract.js'
import { startGroundhog, VERSION } from './server.js'
import type { Email } from './types.js'

function brief(email: Email) {
  return {
    id: email.id,
    subject: email.subject,
    from: email.from?.address ?? null,
    to: email.to.map((a) => a.address),
    via: email.via,
    received_at: email.createdAt,
    code: email.code,
    links: email.links.slice(0, 10),
  }
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) })
    const body = (await response.json()) as { name?: string }
    return body.name === 'groundhog'
  } catch {
    return false
  }
}

async function emailFor(baseUrl: string, input: { id?: string; to?: string; subject?: string; wait_seconds?: number }): Promise<Email> {
  if (input.id) return getEmail(input.id, { baseUrl })
  return waitForEmail({ baseUrl, to: input.to, subject: input.subject, timeout: Math.round((input.wait_seconds ?? 10) * 1000) })
}

export function createMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({ name: 'groundhog', version: VERSION })
  const filters = {
    to: z.string().optional().describe('Recipient address (or @domain) to match'),
    subject: z.string().optional().describe('Text the subject contains'),
  }

  server.registerTool(
    'list_emails',
    {
      title: 'List caught emails',
      description: 'Newest first. Emails the app sent to Groundhog, the local dev inbox; nothing was delivered.',
      inputSchema: { ...filters, limit: z.number().int().min(1).max(100).optional().describe('Default 20') },
      annotations: { readOnlyHint: true },
    },
    async ({ to, subject, limit }) => {
      const emails = await listEmails({ baseUrl, to, subject, limit: limit ?? 20 })
      return text(emails.length ? emails.map(brief) : 'The inbox is empty. Trigger the email in the app first (sign up, reset a password…).')
    },
  )

  server.registerTool(
    'wait_for_email',
    {
      title: 'Wait for an email',
      description: 'Waits until an email matching `to`/`subject` arrives (an already-caught one counts) and returns it with its code and links.',
      inputSchema: { ...filters, timeout_seconds: z.number().min(1).max(300).optional().describe('Default 30') },
      annotations: { readOnlyHint: true },
    },
    async ({ to, subject, timeout_seconds }) => {
      try {
        const email = await waitForEmail({ baseUrl, to, subject, timeout: Math.round((timeout_seconds ?? 30) * 1000) })
        return text({ ...brief(email), text: (email.text ?? '').slice(0, 2000) })
      } catch (error) {
        return failure((error as Error).message)
      }
    },
  )

  server.registerTool(
    'get_email',
    {
      title: 'Read an email',
      description: 'The full text, headers summary, code and links of one email, by id.',
      inputSchema: { id: z.string().describe('Email id from list_emails') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const email = await getEmail(id, { baseUrl })
        return text({ ...brief(email), cc: email.cc.map((a) => a.address), text: email.text, attachments: email.attachments.map((a) => a.filename) })
      } catch (error) {
        return failure((error as Error).message)
      }
    },
  )

  server.registerTool(
    'get_code',
    {
      title: 'Get the one-time code',
      description: 'The verification / sign-in code from the latest matching email (waits briefly if it has not arrived).',
      inputSchema: { ...filters, id: z.string().optional(), wait_seconds: z.number().min(0).max(300).optional().describe('Default 10') },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const email = await emailFor(baseUrl, input)
        if (!email.code) return failure(`"${email.subject}" (${email.id}) has no code in it. Its links: ${email.links.slice(0, 5).join(' ') || 'none'}`)
        return text(email.code)
      } catch (error) {
        return failure((error as Error).message)
      }
    },
  )

  server.registerTool(
    'get_link',
    {
      title: 'Get a link',
      description: 'A link from the latest matching email: the magic link / verify / reset link by default, or the first one containing `contains`.',
      inputSchema: { ...filters, id: z.string().optional(), contains: z.string().optional().describe('Part of the URL to look for, e.g. "/verify"'), wait_seconds: z.number().min(0).max(300).optional().describe('Default 10') },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const email = await emailFor(baseUrl, input)
        const link = pickLink(email.links, input.contains)
        if (!link) return failure(`No ${input.contains ? `link containing "${input.contains}"` : 'link'} in "${email.subject}" (${email.id}).`)
        return text(link)
      } catch (error) {
        return failure((error as Error).message)
      }
    },
  )

  server.registerTool(
    'simulate_fault',
    {
      title: 'Make sends fail',
      description: "Makes the app's next sends fail the way a real provider would (every provider API and SMTP), to test error handling. status: 429 rate limit, 422 invalid recipient, 401 bad key, 5xx outage, timeout. next: 0 turns failure mode off.",
      inputSchema: {
        status: z.enum(['429', '422', '401', '5xx', 'timeout']),
        next: z.number().int().min(0).max(1000).optional().describe('How many sends fail. Default 1'),
      },
    },
    async ({ status, next }) => {
      try {
        await simulateFault({ baseUrl, status: status === '5xx' || status === 'timeout' ? status : (Number(status) as 429 | 422 | 401), next: next ?? 1 })
        return text(next === 0 ? 'Failure mode is off.' : `The next ${next ?? 1} send(s) will fail with ${status}.`)
      } catch (error) {
        return failure((error as Error).message)
      }
    },
  )

  return server
}

export async function runMcp(options: { baseUrl?: string } = {}): Promise<void> {
  let baseUrl = (options.baseUrl ?? process.env.GROUNDHOG_URL ?? 'http://localhost:3025').replace(/\/+$/, '')
  if (!(await reachable(baseUrl))) {
    // No Groundhog running: start one here so the agent still has an inbox.
    try {
      const port = Number(new URL(baseUrl).port) || 3025
      const local = await startGroundhog({ httpPort: port, smtpPort: Number(process.env.GROUNDHOG_SMTP_PORT) || 1025, log: (line) => process.stderr.write(`[groundhog] ${line}\n`) })
      baseUrl = local.url
      process.stderr.write(`[groundhog] started an inbox at ${local.url} (SMTP :${local.smtpPort})\n`)
    } catch (error) {
      process.stderr.write(`[groundhog] could not reach or start Groundhog at ${baseUrl}: ${(error as Error).message}\n`)
    }
  }
  const server = createMcpServer(baseUrl)
  await server.connect(new StdioServerTransport())
}
