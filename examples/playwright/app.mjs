// A tiny app with magic-link sign-in. It sends email over SMTP, the way most apps do.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'

const PORT = Number(process.env.APP_PORT || 3999)
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: Number(process.env.SMTP_PORT || 1025),
})
const tokens = new Map()

const page = (body) => `<!doctype html><html><body style="font-family:sans-serif;padding:40px">${body}</body></html>`

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(page(`
      <h1>Sign in to Acme</h1>
      <form method="post" action="/signin">
        <label>Email <input name="email" type="email" required></label>
        <button>Email me a link</button>
      </form>`))
    return
  }
  if (req.method === 'POST' && url.pathname === '/signin') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const email = new URLSearchParams(raw).get('email')
    const token = randomBytes(12).toString('hex')
    const code = String(Math.floor(100000 + Math.random() * 900000))
    tokens.set(token, email)
    await transport.sendMail({
      from: 'Acme <auth@acme.test>',
      to: email,
      subject: 'Sign in to Acme',
      text: `Your code is ${code}. Or open http://localhost:${PORT}/magic?token=${token}`,
      html: `<p>Your code is <b>${code}</b>.</p><p><a href="http://localhost:${PORT}/magic?token=${token}">Sign in</a></p>`,
    })
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('<h1>Check your email</h1>'))
    return
  }
  if (url.pathname === '/magic') {
    const email = tokens.get(url.searchParams.get('token'))
    res.writeHead(email ? 200 : 401, { 'Content-Type': 'text/html' }).end(page(email ? `<h1>Signed in as ${email}</h1>` : '<h1>Link expired</h1>'))
    return
  }
  res.writeHead(404).end()
}).listen(PORT, () => console.log(`Acme on http://localhost:${PORT}`))
