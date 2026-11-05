// AES-256-GCM encryption for SMTP passwords (WebCrypto, works in Deno and Node 20+).
// The key is a random 32-byte value, base64-encoded, stored only in the Edge Function
// secret SENDER_SECRET_KEY. The sender id is bound as additional authenticated data, so a
// ciphertext copied to another sender row will not decrypt.

const enc = new TextEncoder()
const dec = new TextDecoder()

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export async function importKey(base64Key: string | undefined): Promise<CryptoKey> {
  if (!base64Key) throw new Error('SENDER_SECRET_KEY is not configured')
  const raw = fromB64(base64Key.trim())
  if (raw.length !== 32) throw new Error('SENDER_SECRET_KEY must be 32 random bytes (base64)')
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptSecret(key: CryptoKey, senderId: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(senderId) },
    key,
    enc.encode(plaintext),
  )
  return { ciphertext: toB64(new Uint8Array(ct)), iv: toB64(iv) }
}

export async function decryptSecret(key: CryptoKey, senderId: string, ciphertext: string, iv: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(senderId) },
    key,
    fromB64(ciphertext),
  )
  return dec.decode(pt)
}

/** Constant-time string comparison for shared secrets (cron secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
