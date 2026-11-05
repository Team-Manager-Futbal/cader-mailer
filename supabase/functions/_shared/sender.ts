// Loads a sender account and its decrypted SMTP password (service_role only).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import { decryptSecret, importKey } from './crypto.ts'
import { env } from './runtime.ts'
import { type Connector, type SendEnvelope, type SendResult, SmtpSession, verifySmtp } from './smtp.ts'

export interface SenderAccount {
  id: string
  email: string
  display_name: string
  smtp_host: string
  smtp_port: number
  smtp_tls: boolean
  smtp_username: string
  reply_to: string | null
  active: boolean
  credential_set: boolean
  last_test_ok: boolean | null
  blocked_until: string | null
}

/**
 * Transport abstraction: queue logic depends only on this interface, so another delivery
 * runtime (separate worker, HTTP mail API) can be added without touching the queue.
 */
export interface MailTransport {
  verify(): Promise<void>
  send(envelope: SendEnvelope): Promise<SendResult>
  /** Whether a connection is currently open (sessions are reused within one run). */
  readonly isOpen: boolean
  reset(): Promise<void>
  close(): Promise<void>
}

export async function loadSender(db: SupabaseClient, senderId: string): Promise<{ account: SenderAccount; password: string }> {
  const { data: account, error } = await db.from('sender_accounts').select('*').eq('id', senderId).single()
  if (error || !account) throw new Error('sender_not_found')
  const { data: secret } = await db.from('sender_secrets').select('ciphertext, iv').eq('sender_id', senderId).maybeSingle()
  if (!secret) throw new Error('credential_missing')
  const key = await importKey(env('SENDER_SECRET_KEY'))
  const password = await decryptSecret(key, senderId, secret.ciphertext, secret.iv)
  return { account: account as SenderAccount, password }
}

export function smtpTransport(account: SenderAccount, password: string, connector: Connector): MailTransport {
  if (!account.smtp_tls) {
    // Only implicit TLS is supported; never send credentials over plaintext.
    throw new Error('tls_required')
  }
  const config = {
    host: account.smtp_host,
    port: account.smtp_port,
    username: account.smtp_username || account.email,
    password,
    clientName: account.email.split('@')[1] ?? 'cader-mailer',
  }
  let session: SmtpSession | null = null
  return {
    verify: () => verifySmtp(config, connector),
    get isOpen() {
      return session?.isOpen ?? false
    },
    async send(envelope) {
      if (!session || !session.isOpen) {
        session = new SmtpSession(config, connector)
        await session.open()
      }
      return session.send(envelope)
    },
    async reset() {
      if (session?.isOpen) await session.reset()
    },
    async close() {
      await session?.quit()
      session = null
    },
  }
}
