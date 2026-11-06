import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, importKey, timingSafeEqual } from './crypto'
import { buildMessage, encodeWord, formatAddress, newMessageId } from './mime'
import { classifyReply, SmtpError, SmtpSession, type SmtpSocket, verifySmtp } from './smtp'
import { composeMessage, render, unsubscribeUrl, usedFields } from './template'

describe('template rendering', () => {
  it('fills fields, uses fallbacks and reports missing/unknown placeholders', () => {
    expect(render('Dobrý deň {meno}, {klub}', { meno: 'Ján', klub: 'FK Senec' })).toEqual({
      text: 'Dobrý deň Ján, FK Senec',
      missing: [],
      unknown: [],
    })
    expect(render('Dobrý deň {meno|pán tréner}', {}).text).toBe('Dobrý deň pán tréner')
    const r = render('Ahoj {meno} z {Klub} {mneo}', { meno: '' })
    expect(r.missing).toEqual(['meno', 'klub'])
    expect(r.unknown).toEqual(['mneo'])
    expect(usedFields('{meno} {KLUB|x} {meno}')).toEqual(['meno', 'klub'])
  })

  it('never interprets merge values (plain text only)', () => {
    expect(render('{klub}', { klub: '<b>{meno}</b>' }).text).toBe('<b>{meno}</b>')
  })

  it('adds the signature footer, no visible opt-out link unless the footer uses {odhlasenie}', () => {
    const url = unsubscribeUrl('https://x.github.io/cader-mailer', 'ab'.repeat(32))
    expect(url).toBe(`https://x.github.io/cader-mailer/#/odhlasenie?t=${'ab'.repeat(32)}`)
    const m = composeMessage({
      subject: 'Ponuka\npre {klub}',
      body: 'Text\n\n',
      footer: 'Jakub Kelemen\nCader',
      unsubscribeUrl: url,
      data: { klub: 'FK' },
    })
    expect(m.subject).toBe('Ponuka pre FK')
    expect(m.body).toBe('Text\n\nJakub Kelemen\nCader\n')
    expect(m.body).not.toContain('odhlasenie')
    const withLink = composeMessage({ subject: 's', body: 'Text', footer: 'Odhlásenie: {odhlasenie}', unsubscribeUrl: url, data: {} })
    expect(withLink.body).toBe(`Text\n\nOdhlásenie: ${url}\n`)
    expect(composeMessage({ subject: 's', body: 'Text', footer: '', unsubscribeUrl: url, data: {} }).body).toBe('Text\n')
  })
})

describe('MIME', () => {
  it('encodes Slovak subjects and names and prevents header injection', () => {
    const w = encodeWord('Ponuka pre futbalový klub – Žilina')
    expect(w).toMatch(/^=\?UTF-8\?B\?/)
    const decoded = w
      .split('\r\n ')
      .map((p) => new TextDecoder().decode(Uint8Array.from(atob(p.slice(10, -2)), (c) => c.charCodeAt(0))))
      .join('')
    expect(decoded).toBe('Ponuka pre futbalový klub – Žilina')
    expect(formatAddress({ email: 'a@b.sk', name: 'Jakub\r\nBcc: x@y.z' })).toBe('"Jakub Bcc: x@y.z" <a@b.sk>')
    expect(() => formatAddress({ email: 'a@b.sk>\r\nBcc: x@y.z' })).toThrow()
  })

  it('builds a single-recipient message with unsubscribe headers', () => {
    const raw = buildMessage({
      from: { email: 'jakub@caderapp.com', name: 'Jakub Kelemen' },
      to: { email: 'klub@example.com' },
      replyTo: 'jakub@caderapp.com',
      subject: 'Test',
      text: 'Ahoj\n.bodka\nčšž',
      messageId: newMessageId('jakub@caderapp.com'),
      listUnsubscribeUrl: 'https://p.supabase.co/functions/v1/unsubscribe?t=abc',
    })
    expect(raw).toContain('To: <klub@example.com>\r\n')
    expect(raw).not.toMatch(/^(Cc|Bcc):/m)
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
    expect(raw).toMatch(/Message-ID: <[0-9a-f-]+@caderapp\.com>/)
    const body = raw.split('\r\n\r\n')[1].replace(/\r\n/g, '')
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))).toBe('Ahoj\r\n.bodka\r\nčšž')
  })
})

describe('crypto', () => {
  it('round-trips and binds the ciphertext to the sender id', async () => {
    const key = await importKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))
    const { ciphertext, iv } = await encryptSecret(key, 'sender-1', 'tajné heslo')
    expect(ciphertext).not.toContain('tajné')
    expect(await decryptSecret(key, 'sender-1', ciphertext, iv)).toBe('tajné heslo')
    await expect(decryptSecret(key, 'sender-2', ciphertext, iv)).rejects.toThrow()
    await expect(importKey('c2hvcnQ=')).rejects.toThrow(/32 random bytes/)
  })

  it('compares secrets in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fake SMTP server: a scripted socket.
// ---------------------------------------------------------------------------
type Script = (cmd: string) => string | null | 'hang' | 'close'

function fakeServer(script: Script, greeting = '220 smtp.test ESMTP') {
  const written: string[] = []
  const queue: (Uint8Array | null)[] = [new TextEncoder().encode(`${greeting}\r\n`)]
  let waiting: ((v: Uint8Array | null) => void) | null = null
  let inData = false
  let dataBuf = ''
  const push = (v: Uint8Array | null) => {
    if (waiting) {
      const w = waiting
      waiting = null
      w(v)
    } else queue.push(v)
  }
  const respond = (cmd: string) => {
    const r = script(cmd)
    if (r === 'hang' || r === null) return
    if (r === 'close') return push(null)
    push(new TextEncoder().encode(`${r}\r\n`))
  }
  const socket: SmtpSocket = {
    read: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((res) => (waiting = res))),
    write: async (data) => {
      const s = new TextDecoder().decode(data)
      written.push(s)
      if (inData) {
        dataBuf += s
        if (dataBuf.endsWith('\r\n.\r\n')) {
          inData = false
          respond(`<body>${dataBuf}`)
        }
        return
      }
      for (const line of s.split('\r\n').filter(Boolean)) {
        if (line === 'DATA') inData = true
        respond(line)
      }
    },
    close: () => undefined,
  }
  return { connector: async () => socket, written }
}

const happy: Script = (cmd) => {
  if (cmd.startsWith('EHLO')) return '250-smtp.test\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME'
  if (cmd.startsWith('AUTH PLAIN')) return '235 ok'
  if (cmd.startsWith('MAIL FROM')) return '250 ok'
  if (cmd.startsWith('RCPT TO')) return '250 ok'
  if (cmd === 'DATA') return '354 go'
  if (cmd.startsWith('<body>')) return '250 2.0.0 queued as X'
  if (cmd === 'QUIT') return '221 bye'
  if (cmd === 'RSET') return '250 ok'
  return '500 ?'
}

const cfg = { host: 'smtp.test', port: 465, username: 'jakub@caderapp.com', password: 's3cret', timeoutMs: 200, dataTimeoutMs: 200 }
const env = { from: 'jakub@caderapp.com', to: 'klub@example.com', raw: 'Subject: x\r\n\r\n.line\r\n' }

async function sendWith(script: Script) {
  const srv = fakeServer(script)
  const s = new SmtpSession(cfg, srv.connector)
  try {
    await s.open()
    return { result: await s.send(env), srv }
  } catch (e) {
    return { error: e as SmtpError, srv }
  }
}

describe('SMTP session', () => {
  it('authenticates, sends one recipient with dot-stuffing and returns 250', async () => {
    const { result, srv } = await sendWith(happy)
    expect(result?.code).toBe(250)
    const all = srv.written.join('')
    expect(all).toContain('RCPT TO:<klub@example.com>\r\n')
    expect(all.match(/RCPT TO/g)).toHaveLength(1)
    expect(all).toContain('\r\n..line\r\n.\r\n')
  })

  it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const steps: string[] = []
    const { result } = await sendWith((cmd) => {
      steps.push(cmd)
      if (cmd.startsWith('EHLO')) return '250-smtp.test\r\n250 AUTH LOGIN'
      if (cmd === 'AUTH LOGIN') return '334 VXNlcm5hbWU6'
      if (steps.length === 3) return '334 UGFzc3dvcmQ6'
      if (steps.length === 4) return '235 ok'
      return happy(cmd)
    })
    expect(result?.code).toBe(250)
  })

  it('bad credentials are an auth error without leaking the password', async () => {
    const { error } = await sendWith((cmd) => (cmd.startsWith('AUTH') ? '535 5.7.8 Authentication failed' : happy(cmd)))
    expect(error?.category).toBe('auth')
    expect(error?.ambiguous).toBe(false)
    expect(JSON.stringify(error) + error?.message).not.toContain('s3cret')
    expect(error?.message).not.toContain(btoa('s3cret'))
  })

  it('classifies limits, blocks, recipient rejections and transient errors', () => {
    expect(classifyReply(550, '5.7.1 Too many messages, try later', 'rcpt').category).toBe('rate_limit')
    expect(classifyReply(554, 'Message rejected as spam', 'body').category).toBe('blocked')
    expect(classifyReply(550, '5.1.1 User unknown', 'rcpt').category).toBe('recipient_rejected')
    expect(classifyReply(451, 'Local error', 'rcpt')).toMatchObject({ category: 'transient', retryable: true })
    expect(classifyReply(421, 'Too many connections', 'greeting').category).toBe('rate_limit')
  })

  it('4xx after DATA is a clear (non-ambiguous) failure', async () => {
    const { error } = await sendWith((cmd) => (cmd.startsWith('<body>') ? '451 4.3.0 temporary' : happy(cmd)))
    expect(error).toMatchObject({ category: 'transient', ambiguous: false, phase: 'body' })
  })

  it('no reply after the body was sent is AMBIGUOUS (never auto-retried)', async () => {
    for (const r of ['hang', 'close'] as const) {
      const { error } = await sendWith((cmd) => (cmd.startsWith('<body>') ? r : happy(cmd)))
      expect(error).toMatchObject({ category: 'connection_lost_after_data', ambiguous: true })
    }
  })

  it('connection drop before DATA is not ambiguous', async () => {
    const { error } = await sendWith((cmd) => (cmd.startsWith('RCPT') ? 'close' : happy(cmd)))
    expect(error).toMatchObject({ ambiguous: false, retryable: true, phase: 'rcpt' })
  })

  it('network failures on connect are reported as network errors', async () => {
    const s = new SmtpSession(cfg, async () => {
      throw new Error('Connection refused (os error 61)')
    })
    await expect(s.open()).rejects.toMatchObject({ category: 'network', phase: 'connect' })
    await expect(
      verifySmtp(cfg, async () => {
        throw new Error('invalid peer certificate: UnknownIssuer')
      }),
    ).rejects.toMatchObject({ category: 'tls' })
  })
})
