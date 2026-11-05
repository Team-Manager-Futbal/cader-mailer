// RFC 5322 message builder: one recipient per message, UTF-8 plain text, base64 bodies.

export interface Address {
  email: string
  name?: string
}

export interface OutgoingMessage {
  from: Address
  to: Address
  replyTo?: string
  subject: string
  text: string
  messageId: string
  date?: Date
  /** https URL for List-Unsubscribe (RFC 2369) + one-click POST (RFC 8058). */
  listUnsubscribeUrl?: string
}

const enc = new TextEncoder()

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Header-injection guard: header values may never contain CR/LF. */
export function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim()
}

const ASCII_SAFE = /^[\x20-\x7e]*$/

/** RFC 2047 encoded-word, split so each line stays short. */
export function encodeWord(text: string): string {
  const clean = headerSafe(text)
  if (ASCII_SAFE.test(clean) && clean.length < 900) return clean
  const words: string[] = []
  let chunk = ''
  for (const ch of clean) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(`=?UTF-8?B?${b64(enc.encode(chunk))}?=`)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(`=?UTF-8?B?${b64(enc.encode(chunk))}?=`)
  return words.join('\r\n ')
}

export function isValidEmail(email: string): boolean {
  return (
    email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email)
  )
}

export function formatAddress(a: Address): string {
  if (!isValidEmail(a.email)) throw new Error('invalid_address')
  if (!a.name) return `<${a.email}>`
  const name = headerSafe(a.name)
  const display = ASCII_SAFE.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodeWord(name)
  return `${display} <${a.email}>`
}

function rfc5322Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes(),
  )}:${p(d.getUTCSeconds())} +0000`
}

export function newMessageId(senderEmail: string): string {
  const domain = senderEmail.split('@')[1] ?? 'localhost'
  return `<${crypto.randomUUID()}@${domain}>`
}

/** Builds the full message. Lines are CRLF-terminated and never begin with a dot. */
export function buildMessage(m: OutgoingMessage): string {
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${formatAddress(m.to)}`,
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${rfc5322Date(m.date ?? new Date())}`,
    `Message-ID: ${headerSafe(m.messageId)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  if (m.replyTo) {
    if (!isValidEmail(m.replyTo)) throw new Error('invalid_reply_to')
    headers.push(`Reply-To: <${m.replyTo}>`)
  }
  if (m.listUnsubscribeUrl) {
    if (!/^https:\/\/[^\s<>]+$/.test(m.listUnsubscribeUrl)) throw new Error('invalid_unsubscribe_url')
    headers.push(`List-Unsubscribe: <${m.listUnsubscribeUrl}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  }
  const normalized = m.text.replace(/\r\n|\r|\n/g, '\r\n')
  const body = (b64(enc.encode(normalized)).match(/.{1,76}/g) ?? ['']).join('\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`
}

/** SMTP DATA transparency (RFC 5321 4.5.2). */
export function dotStuff(raw: string): string {
  return raw.replace(/(^|\r\n)\./g, '$1..')
}
