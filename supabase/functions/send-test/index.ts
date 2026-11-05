// Sends exactly ONE clearly marked test message to the caller's own address or an
// admin-approved test address. Same permission checks and caps as real campaigns.
import { z } from 'npm:zod@4.6.7'
import { buildMessage, isValidEmail, newMessageId } from '../_shared/mime.ts'
import { audit, denoTlsConnector, handle, HttpError, json, readJson, requireCaller, serviceClient } from '../_shared/runtime.ts'
import { loadSender, smtpTransport } from '../_shared/sender.ts'
import { describeError, SmtpError } from '../_shared/smtp.ts'
import { composeMessage } from '../_shared/template.ts'

const Body = z.object({
  sender_id: z.uuid(),
  to: z.string().trim().toLowerCase().max(254),
  subject: z.string().max(500),
  body: z.string().max(50_000),
  merge: z
    .object({ meno: z.string().max(200).optional(), klub: z.string().max(200).optional(), pozicia: z.string().max(200).optional() })
    .default({}),
  confirmed: z.literal(true),
})

Deno.serve(
  handle(async (req) => {
    const caller = await requireCaller(req)
    const input = await readJson(req, (v) => Body.parse(v))
    const db = serviceClient()

    if (!isValidEmail(input.to)) throw new HttpError(400, 'invalid_recipient', 'Neplatná adresa príjemcu testu.')
    const { data: settings } = await db.from('app_settings').select('footer_text, test_recipient_allowlist').eq('id', 1).single()
    const allow = new Set([caller.email.toLowerCase(), ...((settings?.test_recipient_allowlist ?? []) as string[]).map((s) => s.toLowerCase())])
    if (!allow.has(input.to)) {
      throw new HttpError(403, 'recipient_not_allowed', 'Test možno poslať len na vlastnú adresu alebo adresu schválenú adminom.')
    }

    if (caller.role !== 'admin') {
      const { data: perm } = await db
        .from('sender_permissions')
        .select('sender_id')
        .eq('sender_id', input.sender_id)
        .eq('user_id', caller.id)
        .maybeSingle()
      if (!perm) throw new HttpError(403, 'sender_not_permitted', 'Tohto odosielateľa nemáte pridelený.')
    }

    const composed = composeMessage({
      subject: input.subject,
      body: input.body,
      footer: settings?.footer_text ?? '',
      unsubscribeUrl: 'https://example.invalid/test-odhlasenie',
      data: input.merge,
    })
    if (composed.missing.length || composed.unknown.length) {
      throw new HttpError(400, 'template_error', `Chýbajúce alebo neznáme polia: ${[...composed.missing, ...composed.unknown].join(', ')}`)
    }

    let loaded
    try {
      loaded = await loadSender(db, input.sender_id)
    } catch {
      throw new HttpError(409, 'sender_not_ready', 'Odosielateľ nemá nastavené heslo.')
    }
    const { account, password } = loaded

    const { data: attemptId, error: reserveError } = await db.rpc('reserve_test_send', { p_sender: input.sender_id, p_user: caller.id })
    if (reserveError) {
      const code = reserveError.message.match(/sender_not_ready|sender_blocked|rate_limited|test_quota_exceeded/)?.[0] ?? 'reserve_failed'
      throw new HttpError(409, code, {
        sender_not_ready: 'Odosielateľ nie je aktívny alebo nemá nastavené heslo.',
        sender_blocked: 'Odosielateľ je zablokovaný po odmietnutí poskytovateľom.',
        rate_limited: 'Limit odosielania pre tohto odosielateľa je momentálne vyčerpaný.',
        test_quota_exceeded: 'Prekročený limit testovacích správ (10 za hodinu).',
      }[code] ?? 'Test sa nepodarilo pripraviť.')
    }

    const transport = smtpTransport(account, password, denoTlsConnector)
    const messageId = newMessageId(account.email)
    const raw = buildMessage({
      from: { email: account.email, name: account.display_name || undefined },
      to: { email: input.to },
      replyTo: account.reply_to ?? undefined,
      subject: `[TEST] ${composed.subject}`,
      text: `*** TESTOVACIA SPRÁVA – nie je súčasťou kampane ***\n\n${composed.body}`,
      messageId,
    })

    try {
      const res = await transport.send({ from: account.email, to: input.to, raw })
      await db.rpc('finish_test_send', { p_attempt: attemptId, p_outcome: 'accepted_by_smtp', p_smtp_code: res.code, p_error_category: null, p_error: null })
      await audit(db, caller.id, 'test.send', 'sender_account', input.sender_id, { ok: true })
      return json(req, { ok: true, message: 'Testovacia správa bola prijatá SMTP serverom (to ešte nepotvrdzuje doručenie do schránky).' })
    } catch (e) {
      const err = e instanceof SmtpError ? e : null
      await db.rpc('finish_test_send', {
        p_attempt: attemptId,
        p_outcome: err?.ambiguous ? 'unknown_outcome' : err?.retryable ? 'temporary_failure' : 'permanent_failure',
        p_smtp_code: err?.code ?? null,
        p_error_category: err?.category ?? 'unexpected',
        p_error: err?.message ?? 'unexpected',
      })
      await audit(db, caller.id, 'test.send', 'sender_account', input.sender_id, { ok: false, category: err?.category ?? 'unexpected' })
      return json(req, { ok: false, category: err?.category ?? 'unexpected', message: err ? `${describeError(err)} ${err.message}` : 'Neočakávaná chyba.' }, 502)
    } finally {
      await transport.close()
    }
  }),
)
