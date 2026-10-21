#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { withUtm } from './groundmail-account.js'
import { startGroundhog, VERSION } from './server.js'

const HELP = `Groundhog ${VERSION}: a local inbox for development. Catches every email your app sends; nothing is delivered.

Usage
  npx @groundmail/groundhog [options]     start the inbox
  npx @groundmail/groundhog mcp           MCP server (stdio) for coding agents

Options
  --smtp-port <port>    SMTP port (default 1025, env GROUNDHOG_SMTP_PORT)
  --http-port <port>    web UI + APIs (default 3025, env GROUNDHOG_HTTP_PORT)
  --host <host>         listen address (default localhost; 0.0.0.0 in Docker, env GROUNDHOG_HOST)
  --store <file>        keep emails in this JSON file across restarts (env GROUNDHOG_STORE)
  --max <n>             emails kept in memory (default 1000)
  --webhook-url <url>   where simulated webhooks go (env GROUNDHOG_WEBHOOK_URL)
  --no-open             don't open the browser
  --quiet               don't log each caught email
  -v, --version         print the version
  -h, --help            this help

Point your app at it
  SMTP              localhost:1025, any username and password
  Groundmail SDK    new Groundmail(key, { baseUrl: 'http://localhost:3025' })
  SendGrid          sgMail.client.setDefaultRequest('baseUrl', 'http://localhost:3025/sendgrid')
  Postmark          new ServerClient(key, { requestHost: 'localhost:3025/postmark', useHttps: false })
  Mailgun           mailgun.client({ username: 'api', key, url: 'http://localhost:3025/mailgun' })
  Resend            RESEND_BASE_URL=http://localhost:3025/resend
  Amazon SES        new SESv2Client({ endpoint: 'http://localhost:3025/ses' })

Docs: https://github.com/Groundmail/groundhog`

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is printed either way.
  }
}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`Not a port: ${value}`)
    process.exit(2)
  }
  return n
}

async function main(argv: string[]) {
  if (argv[0] === 'mcp') {
    const { runMcp } = await import('./mcp.js')
    await runMcp()
    return
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'smtp-port': { type: 'string' },
      'http-port': { type: 'string' },
      host: { type: 'string' },
      store: { type: 'string' },
      max: { type: 'string' },
      'webhook-url': { type: 'string' },
      open: { type: 'boolean', default: true },
      'no-open': { type: 'boolean' },
      quiet: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help || positionals[0] === 'help') {
    console.log(HELP)
    return
  }
  if (values.version) {
    console.log(VERSION)
    return
  }
  if (positionals.length && positionals[0] !== 'start') {
    console.error(`Unknown command: ${positionals[0]}\n\n${HELP}`)
    process.exit(2)
  }
  const env = process.env
  const gh = await startGroundhog({
    smtpPort: port(values['smtp-port'] ?? env.GROUNDHOG_SMTP_PORT, 1025),
    httpPort: port(values['http-port'] ?? env.GROUNDHOG_HTTP_PORT, 3025),
    host: values.host ?? env.GROUNDHOG_HOST ?? 'localhost',
    storeFile: values.store ?? env.GROUNDHOG_STORE,
    maxEmails: values.max ? Number(values.max) : undefined,
    webhooks: { url: values['webhook-url'] ?? env.GROUNDHOG_WEBHOOK_URL ?? null },
    openBrowser: openInBrowser,
    log: values.quiet ? undefined : (line) => console.log(`  ${new Date().toLocaleTimeString()}  ${line}`),
  }).catch((error: Error) => {
    console.error(`\n  ${error.message}\n`)
    process.exit(1)
  })

  console.log(`
  Groundhog ${VERSION} is catching email. Nothing leaves this machine.

    Inbox   ${gh.url}
    SMTP    localhost:${gh.smtpPort}  (any username and password)
    APIs    ${gh.url}/<groundmail|sendgrid|postmark|mailgun|resend|ses>

  From Groundmail: ${withUtm('https://groundmail.dev/', 'cli')}
`)
  const wantsOpen = values.open !== false && !values['no-open'] && process.stdout.isTTY && !env.CI && !env.GROUNDHOG_NO_OPEN
  if (wantsOpen) openInBrowser(gh.url)

  let closing = false
  const shutdown = async () => {
    if (closing) process.exit(0)
    closing = true
    await gh.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error)
  process.exit(1)
})
