// Minimal SMTP client over an implicit-TLS socket (port 465), runtime-agnostic.
// The socket is injected, so the same code runs in Deno (Edge Functions), Node, and unit tests.
// Credentials are never included in errors or logs.

export interface SmtpSocket {
  read(): Promise<Uint8Array | null>
  write(data: Uint8Array): Promise<void>
  close(): void
}

export type Connector = (host: string, port: number) => Promise<SmtpSocket>

export interface SmtpConfig {
  host: string
  port: number
  username: string
  password: string
  /** Name sent in EHLO. */
  clientName?: string
  timeoutMs?: number
  dataTimeoutMs?: number
}

export type ErrorCategory =
  | 'network'
  | 'tls'
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'blocked'
  | 'sender_rejected'
  | 'recipient_rejected'
  | 'message_rejected'
  | 'transient'
  | 'protocol'
  | 'connection_lost_after_data'

export type Phase = 'connect' | 'greeting' | 'ehlo' | 'auth' | 'mail' | 'rcpt' | 'data' | 'body' | 'quit'

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly category: ErrorCategory,
    readonly phase: Phase,
    readonly code: number | null,
    /** true = the server may already have accepted the message; never retry automatically. */
    readonly ambiguous = false,
    /** true = a transient condition that is safe to retry later (with backoff). */
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'SmtpError'
  }
}

interface Reply {
  code: number
  lines: string[]
}

const LIMIT_TEXT = /(rate|limit|quota|too many|exceed|throttl|try again later|frequen)/i
const BLOCK_TEXT = /(spam|block|blacklist|denylist|reputation|policy|banned|suspend|abuse|not allowed to send)/i

/** Maps an SMTP reply to our error taxonomy. Exported for unit tests. */
export function classifyReply(code: number, text: string, phase: Phase): SmtpError {
  const t = sanitizeServerText(text)
  const msg = `SMTP ${code} (${phase}): ${t}`
  if (phase === 'auth') {
    if (code === 454 || code === 421) return new SmtpError(msg, 'transient', phase, code, false, true)
    return new SmtpError(msg, 'auth', phase, code)
  }
  if (LIMIT_TEXT.test(t)) return new SmtpError(msg, 'rate_limit', phase, code)
  if (BLOCK_TEXT.test(t)) return new SmtpError(msg, 'blocked', phase, code)
  if (code >= 400 && code < 500) {
    return new SmtpError(msg, 'transient', phase, code, false, true)
  }
  if (phase === 'mail') return new SmtpError(msg, 'sender_rejected', phase, code)
  if (phase === 'rcpt') return new SmtpError(msg, 'recipient_rejected', phase, code)
  if (phase === 'body') return new SmtpError(msg, 'message_rejected', phase, code)
  return new SmtpError(msg, 'protocol', phase, code)
}

/** Server replies are logged/stored; keep them short and strip anything that is not printable. */
export function sanitizeServerText(text: string): string {
  return text.replace(/[^\x20-\x7e\u00a0-ſ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64(s: string): string {
  const bytes = enc.encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

class LineReader {
  private buf = ''
  constructor(private socket: SmtpSocket) {}

  async readLine(timeoutMs: number): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n')
      if (i >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 2)
        return line
      }
      const chunk = await withTimeout(this.socket.read(), timeoutMs)
      if (chunk === null) throw new Error('connection_closed')
      this.buf += dec.decode(chunk, { stream: true })
      if (this.buf.length > 64 * 1024) throw new Error('reply_too_long')
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError('timeout')), ms)
    }),
  ])
}

export interface SendEnvelope {
  from: string
  to: string
  /** Full RFC 5322 message, CRLF line endings. */
  raw: string
}

export interface SendResult {
  code: number
  response: string
}

/**
 * One SMTP session: connect → EHLO → AUTH → (MAIL/RCPT/DATA)* → QUIT.
 * Errors before the final DATA reply are unambiguous (the message was not accepted).
 * A lost connection or timeout after the message body was transmitted is AMBIGUOUS.
 */
export class SmtpSession {
  private socket: SmtpSocket | null = null
  private reader: LineReader | null = null
  private phase: Phase = 'connect'

  constructor(
    private config: SmtpConfig,
    private connector: Connector,
  ) {}

  private get timeout() {
    return this.config.timeoutMs ?? 30_000
  }

  async open(): Promise<void> {
    this.phase = 'connect'
    try {
      this.socket = await withTimeout(this.connector(this.config.host, this.config.port), this.timeout)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (e instanceof TimeoutError) throw new SmtpError('Pripojenie vypršalo (timeout).', 'timeout', 'connect', null, false, true)
      const tls = /tls|certificate|handshake|ssl/i.test(m)
      throw new SmtpError(
        tls ? `TLS chyba: ${sanitizeServerText(m)}` : `Sieťová chyba: ${sanitizeServerText(m)}`,
        tls ? 'tls' : 'network',
        'connect',
        null,
        false,
        !tls,
      )
    }
    this.reader = new LineReader(this.socket)
    this.phase = 'greeting'
    await this.expect([220])
    this.phase = 'ehlo'
    const ehlo = await this.command(`EHLO ${this.config.clientName ?? 'cader-mailer'}`, [250])
    const caps = ehlo.lines.map((l) => l.toUpperCase())
    this.phase = 'auth'
    const authLine = caps.find((l) => l.startsWith('AUTH'))
    if (authLine?.includes('PLAIN')) {
      await this.command(`AUTH PLAIN ${b64(`\0${this.config.username}\0${this.config.password}`)}`, [235])
    } else {
      await this.command('AUTH LOGIN', [334])
      await this.command(b64(this.config.username), [334])
      await this.command(b64(this.config.password), [235])
    }
  }

  async send(env: SendEnvelope): Promise<SendResult> {
    if (!this.socket) throw new SmtpError('Session not open', 'protocol', 'mail', null)
    this.phase = 'mail'
    await this.command(`MAIL FROM:<${env.from}>`, [250])
    this.phase = 'rcpt'
    await this.command(`RCPT TO:<${env.to}>`, [250, 251])
    this.phase = 'data'
    await this.command('DATA', [354])
    this.phase = 'body'
    const payload = env.raw.replace(/(^|\r\n)\./g, '$1..')
    let reply: Reply
    try {
      await this.write(`${payload}${payload.endsWith('\r\n') ? '' : '\r\n'}.\r\n`)
      reply = await this.readReply(this.config.dataTimeoutMs ?? 120_000)
    } catch (e) {
      if (e instanceof SmtpError) throw e
      throw new SmtpError(
        'Spojenie sa prerušilo po odoslaní obsahu správy, výsledok nie je známy.',
        'connection_lost_after_data',
        'body',
        null,
        true,
      )
    }
    if (reply.code !== 250) {
      throw classifyReply(reply.code, reply.lines.join(' '), 'body')
    }
    return { code: reply.code, response: sanitizeServerText(reply.lines.join(' ')) }
  }

  /** Resets the transaction after a failed MAIL/RCPT so the session can be reused. */
  async reset(): Promise<void> {
    try {
      await this.command('RSET', [250])
    } catch {
      this.close()
    }
  }

  async quit(): Promise<void> {
    if (!this.socket) return
    this.phase = 'quit'
    try {
      await this.write('QUIT\r\n')
      await this.readReply(5_000)
    } catch {
      // ignore
    } finally {
      this.close()
    }
  }

  close(): void {
    try {
      this.socket?.close()
    } catch {
      // ignore
    }
    this.socket = null
    this.reader = null
  }

  get isOpen(): boolean {
    return this.socket !== null
  }

  private async write(s: string): Promise<void> {
    if (!this.socket) throw new Error('connection_closed')
    await withTimeout(this.socket.write(enc.encode(s)), this.timeout)
  }

  private async readReply(timeoutMs = this.timeout): Promise<Reply> {
    if (!this.reader) throw new Error('connection_closed')
    const lines: string[] = []
    for (;;) {
      const line = await this.reader.readLine(timeoutMs)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) throw new SmtpError(`Neplatná odpoveď servera.`, 'protocol', this.phase, null)
      lines.push(m[3])
      if (m[2] === ' ') return { code: Number(m[1]), lines }
      if (lines.length > 100) throw new SmtpError('Príliš dlhá odpoveď servera.', 'protocol', this.phase, null)
    }
  }

  private async expect(codes: number[]): Promise<Reply> {
    let reply: Reply
    try {
      reply = await this.readReply()
    } catch (e) {
      throw this.transportError(e)
    }
    if (!codes.includes(reply.code)) throw classifyReply(reply.code, reply.lines.join(' '), this.phase)
    return reply
  }

  private async command(line: string, codes: number[]): Promise<Reply> {
    // Lines may carry credentials (AUTH); they are never logged or included in errors.
    try {
      await this.write(`${line}\r\n`)
    } catch (e) {
      throw this.transportError(e)
    }
    return this.expect(codes)
  }

  private transportError(e: unknown): SmtpError {
    if (e instanceof SmtpError) return e
    this.close()
    if (e instanceof TimeoutError) {
      return new SmtpError(`Server neodpovedal včas (${this.phase}).`, 'timeout', this.phase, null, false, true)
    }
    return new SmtpError(`Spojenie so serverom sa prerušilo (${this.phase}).`, 'network', this.phase, null, false, true)
  }
}

/** Opens a session, authenticates, and quits. Used by the admin "test connection" button. */
export async function verifySmtp(config: SmtpConfig, connector: Connector): Promise<void> {
  const s = new SmtpSession(config, connector)
  try {
    await s.open()
  } finally {
    await s.quit()
  }
}

/** Human-readable Slovak explanation for the admin UI. */
export function describeError(e: SmtpError): string {
  switch (e.category) {
    case 'auth':
      return 'Prihlásenie na SMTP zlyhalo. Skontrolujte používateľa a heslo (pri 2FA aplikačné heslo).'
    case 'tls':
      return 'Nepodarilo sa nadviazať TLS spojenie. Skontrolujte host a port (465 = SSL/TLS).'
    case 'network':
      return 'Sieťové spojenie na SMTP server zlyhalo. Prostredie môže blokovať odchádzajúci port.'
    case 'timeout':
      return 'SMTP server neodpovedal včas.'
    case 'rate_limit':
      return 'Poskytovateľ hlási prekročenie limitu odosielania. Odosielanie bolo zastavené.'
    case 'blocked':
      return 'Poskytovateľ odmietol správu (blokovanie alebo politika). Odosielanie bolo zastavené.'
    case 'recipient_rejected':
      return 'Server odmietol adresu príjemcu.'
    case 'sender_rejected':
      return 'Server odmietol adresu odosielateľa.'
    case 'message_rejected':
      return 'Server odmietol obsah správy.'
    case 'connection_lost_after_data':
      return 'Spojenie sa prerušilo po odoslaní obsahu – nie je isté, či server správu prijal.'
    case 'transient':
      return 'Dočasná chyba servera, skúsi sa neskôr.'
    default:
      return 'Neočakávaná odpoveď SMTP servera.'
  }
}
