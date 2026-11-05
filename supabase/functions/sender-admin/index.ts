// Admin-only: store/clear SMTP password (AES-256-GCM, never returned) and test the connection.
import { z } from 'npm:zod@4.6.7'
import { encryptSecret, importKey } from '../_shared/crypto.ts'
import { audit, denoTlsConnector, env, handle, HttpError, json, readJson, requireCaller, serviceClient } from '../_shared/runtime.ts'
import { loadSender, smtpTransport } from '../_shared/sender.ts'
import { describeError, SmtpError } from '../_shared/smtp.ts'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_password'), sender_id: z.uuid(), password: z.string().min(1).max(500) }),
  z.object({ action: z.literal('clear_password'), sender_id: z.uuid() }),
  z.object({ action: z.literal('test'), sender_id: z.uuid() }),
])

Deno.serve(
  handle(async (req) => {
    const caller = await requireCaller(req, { admin: true })
    const input = await readJson(req, (v) => Body.parse(v))
    const db = serviceClient()

    const { data: exists } = await db.from('sender_accounts').select('id').eq('id', input.sender_id).maybeSingle()
    if (!exists) throw new HttpError(404, 'sender_not_found')

    if (input.action === 'set_password') {
      const key = await importKey(env('SENDER_SECRET_KEY'))
      const sealed = await encryptSecret(key, input.sender_id, input.password)
      const { error } = await db
        .from('sender_secrets')
        .upsert({ sender_id: input.sender_id, ...sealed, updated_at: new Date().toISOString() })
      if (error) throw new HttpError(500, 'store_failed')
      await db
        .from('sender_accounts')
        .update({ credential_set: true, last_test_ok: null, last_test_message: 'Heslo uložené, otestujte pripojenie.' })
        .eq('id', input.sender_id)
      await audit(db, caller.id, 'sender.set_password', 'sender_account', input.sender_id)
      return json(req, { ok: true })
    }

    if (input.action === 'clear_password') {
      await db.from('sender_secrets').delete().eq('sender_id', input.sender_id)
      await db
        .from('sender_accounts')
        .update({ credential_set: false, active: false, last_test_ok: null, last_test_message: 'Heslo odstránené.' })
        .eq('id', input.sender_id)
      await audit(db, caller.id, 'sender.clear_password', 'sender_account', input.sender_id)
      return json(req, { ok: true })
    }

    // test: real TLS + AUTH handshake from the deployed runtime, no message is sent.
    let ok = false
    let message: string
    let category: string | null = null
    try {
      const { account, password } = await loadSender(db, input.sender_id)
      await smtpTransport(account, password, denoTlsConnector).verify()
      ok = true
      message = `Pripojenie a prihlásenie na ${account.smtp_host}:${account.smtp_port} je v poriadku.`
    } catch (e) {
      if (e instanceof SmtpError) {
        category = e.category
        message = `${describeError(e)} (${e.message})`
      } else {
        const m = e instanceof Error ? e.message : String(e)
        category = m
        message =
          m === 'credential_missing'
            ? 'Heslo nie je nastavené.'
            : m === 'tls_required'
              ? 'Podporované je len SSL/TLS pripojenie (port 465).'
              : `Test zlyhal: ${m.slice(0, 200)}`
      }
    }
    await db
      .from('sender_accounts')
      .update({ last_test_at: new Date().toISOString(), last_test_ok: ok, last_test_message: message.slice(0, 500) })
      .eq('id', input.sender_id)
    await audit(db, caller.id, 'sender.test', 'sender_account', input.sender_id, { ok, category })
    return json(req, { ok, message, category })
  }),
)
