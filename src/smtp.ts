import { SMTPServer, type SMTPServerSession } from 'smtp-server'
import type { Faults } from './faults.js'
import { parseEmail } from './mime.js'
import type { FaultKind, StoredEmail } from './types.js'

type SmtpError = Error & { responseCode: number }

function smtpError(code: number, message: string): SmtpError {
  const error = new Error(message) as SmtpError
  error.responseCode = code
  return error
}

/** The SMTP reply a real server gives for each simulated failure. */
export const SMTP_FAULT_REPLIES: Record<Exclude<FaultKind, 'timeout'>, { code: number; message: string }> = {
  rate_limit: { code: 450, message: '4.7.1 Rate limit exceeded, try again later' },
  invalid_recipient: { code: 550, message: '5.1.1 Recipient address rejected: user unknown' },
  unauthorized: { code: 535, message: '5.7.8 Authentication credentials invalid' },
  outage: { code: 451, message: '4.3.0 Temporary server failure, try again later' },
}

type FaultSession = SMTPServerSession & { groundhogFault?: FaultKind | null }

export function createSmtpServer(options: {
  faults: Faults
  ingest: (email: StoredEmail) => void
  onError?: (error: Error) => void
}): SMTPServer {
  const { faults, ingest } = options
  const server = new SMTPServer({
    name: 'groundhog.local',
    banner: 'Groundhog local inbox. Nothing is delivered.',
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    size: 50 * 1024 * 1024,
    logger: false,
    onAuth(_auth, _session, callback) {
      callback(null, { user: 'groundhog' })
    },
    onMailFrom(_address, session: FaultSession, callback) {
      const fault = faults.take()
      session.groundhogFault = fault
      if (!fault || fault === 'invalid_recipient') return callback()
      if (fault === 'timeout') {
        const delay = faults.get().timeoutMs
        setTimeout(() => callback(smtpError(421, '4.4.2 Connection timed out')), delay).unref?.()
        return
      }
      const reply = SMTP_FAULT_REPLIES[fault]
      callback(smtpError(reply.code, reply.message))
    },
    onRcptTo(_address, session: FaultSession, callback) {
      if (session.groundhogFault === 'invalid_recipient') {
        const reply = SMTP_FAULT_REPLIES.invalid_recipient
        return callback(smtpError(reply.code, reply.message))
      }
      callback()
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', async () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
          return callback(smtpError(552, '5.3.4 Message too big'))
        }
        try {
          const envelopeTo = session.envelope.rcptTo.map((rcpt) => ({ name: '', address: rcpt.address }))
          const email = await parseEmail(Buffer.concat(chunks), { via: 'smtp', envelopeTo })
          ingest(email)
          callback(null, `2.0.0 Caught as ${email.id}. Nothing was delivered.`)
        } catch (error) {
          options.onError?.(error as Error)
          callback(smtpError(451, '4.3.0 Could not read the message'))
        }
      })
    },
  })
  server.on('error', (error) => options.onError?.(error))
  return server
}
