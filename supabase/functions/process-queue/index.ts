// Protected queue processor. Invoked about once per minute by pg_cron + pg_net with the
// x-cron-secret header (secret stored in Supabase Vault). Never callable with user/anon keys.
//
// Flow per invocation:
//   claim_due_recipients()  -> atomic claim (FOR UPDATE SKIP LOCKED, per-sender caps, leases)
//   for each claimed row:   re-check (pause/cancel/suppression) -> SMTP -> finish_attempt()
import { timingSafeEqual } from '../_shared/crypto.ts'
import { buildMessage, newMessageId } from '../_shared/mime.ts'
import { denoTlsConnector, env, serviceClient } from '../_shared/runtime.ts'
import { loadSender, type MailTransport, smtpTransport } from '../_shared/sender.ts'
import { SmtpError } from '../_shared/smtp.ts'
import { composeMessage, unsubscribeUrl } from '../_shared/template.ts'

interface Claim {
  recipient_id: string
  lease_token: string
  attempt_id: number
  attempt_no: number
  campaign_id: string
  sender_id: string
  email: string
  meno: string
  klub: string
  pozicia: string
  subject: string
  body_text: string
  unsubscribe_token: string
}

type Outcome = 'accepted_by_smtp' | 'temporary_failure' | 'permanent_failure' | 'unknown_outcome'

const HALTING = new Set(['auth', 'rate_limit', 'blocked'])
const MAX_PER_RUN = 20
// Lease must outlive the whole run (Edge Function wall clock limit is 150 s on the free plan).
const LEASE_SECONDS = 300

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 })
  const expected = env('CRON_SECRET')
  if (!timingSafeEqual(req.headers.get('x-cron-secret') ?? '', expected)) {
    return new Response('unauthorized', { status: 401 })
  }

  const db = serviceClient()
  const started = Date.now()
  const summary = { claimed: 0, accepted: 0, temporary: 0, permanent: 0, unknown: 0, released: 0 }

  const { data: settings, error: settingsError } = await db
    .from('app_settings')
    .select('frontend_url, footer_text')
    .eq('id', 1)
    .single()
  if (settingsError || !settings) return Response.json({ error: 'settings_unavailable' }, { status: 500 })

  const { data, error } = await db.rpc('claim_due_recipients', { p_max: MAX_PER_RUN, p_lease_seconds: LEASE_SECONDS })
  if (error) {
    console.error('claim failed', error.message)
    return Response.json({ error: 'claim_failed' }, { status: 500 })
  }
  const claims = (data ?? []) as Claim[]
  summary.claimed = claims.length

  const finish = async (c: Claim, outcome: Outcome, code: number | null, category: string | null, message: string | null, messageId: string | null) => {
    const { error: e } = await db.rpc('finish_attempt', {
      p_recipient: c.recipient_id,
      p_lease: c.lease_token,
      p_attempt: c.attempt_id,
      p_outcome: outcome,
      p_smtp_code: code,
      p_error_category: category,
      p_error: message,
      p_message_id: messageId,
    })
    if (e) console.error('finish_attempt failed', e.message)
    summary[outcome === 'accepted_by_smtp' ? 'accepted' : outcome === 'temporary_failure' ? 'temporary' : outcome === 'permanent_failure' ? 'permanent' : 'unknown']++
  }
  const release = async (c: Claim) => {
    await db.rpc('release_unsent', { p_recipient: c.recipient_id, p_lease: c.lease_token, p_attempt: c.attempt_id })
    summary.released++
  }

  // Without a public unsubscribe page we must not send marketing messages at all.
  if (!/^https:\/\//.test(settings.frontend_url ?? '')) {
    console.error('frontend_url not configured; releasing all claims')
    for (const c of claims) await release(c)
    return Response.json({ ...summary, error: 'frontend_url_missing' })
  }

  const bySender = new Map<string, Claim[]>()
  for (const c of claims) bySender.set(c.sender_id, [...(bySender.get(c.sender_id) ?? []), c])

  for (const [senderId, group] of bySender) {
    let transport: MailTransport
    let account
    try {
      const loaded = await loadSender(db, senderId)
      account = loaded.account
      transport = smtpTransport(loaded.account, loaded.password, denoTlsConnector)
    } catch (e) {
      // Unusable credentials: halt this sender (no SMTP contact happened, so it is unambiguous).
      const msg = e instanceof Error ? e.message : 'credential_error'
      await finish(group[0], 'temporary_failure', null, 'auth', `Prihlasovacie údaje nie sú použiteľné (${msg}).`, null)
      for (const c of group.slice(1)) await release(c)
      continue
    }

    let halted = false
    for (const c of group) {
      if (halted || Date.now() - started > 120_000) {
        await release(c)
        continue
      }
      // Pause / cancel / unsubscribe may have happened after the claim.
      const { data: ok } = await db.rpc('recipient_still_sendable', { p_recipient: c.recipient_id, p_lease: c.lease_token })
      if (ok !== true) {
        await release(c)
        continue
      }

      const msg = composeMessage({
        subject: c.subject,
        body: c.body_text,
        footer: settings.footer_text,
        unsubscribeUrl: unsubscribeUrl(settings.frontend_url, c.unsubscribe_token),
        data: { meno: c.meno, klub: c.klub, pozicia: c.pozicia },
      })
      if (msg.missing.length || msg.unknown.length) {
        await finish(c, 'permanent_failure', null, 'template_error',
          `Chýbajúce údaje pre: ${[...msg.missing, ...msg.unknown].join(', ')}`, null)
        continue
      }

      const messageId = newMessageId(account.email)
      let raw: string
      try {
        raw = buildMessage({
          from: { email: account.email, name: account.display_name || undefined },
          to: { email: c.email },
          replyTo: account.reply_to ?? undefined,
          subject: msg.subject,
          text: msg.body,
          messageId,
          listUnsubscribeUrl: `${env('SUPABASE_URL')}/functions/v1/unsubscribe?t=${c.unsubscribe_token}`,
        })
      } catch (e) {
        await finish(c, 'permanent_failure', null, 'invalid_address', e instanceof Error ? e.message : 'build_failed', null)
        continue
      }

      try {
        const res = await transport.send({ from: account.email, to: c.email, raw })
        await finish(c, 'accepted_by_smtp', res.code, null, null, messageId)
      } catch (e) {
        if (!(e instanceof SmtpError)) {
          // Unknown failure mode: be conservative.
          await finish(c, 'unknown_outcome', null, 'unexpected', e instanceof Error ? e.message.slice(0, 200) : 'unexpected', null)
          halted = true
          continue
        }
        if (e.ambiguous) {
          await finish(c, 'unknown_outcome', e.code, e.category, e.message, messageId)
        } else if (HALTING.has(e.category) || e.category === 'sender_rejected') {
          await finish(c, 'temporary_failure', e.code, e.category === 'sender_rejected' ? 'blocked' : e.category, e.message, null)
          halted = true
        } else if (e.retryable) {
          await finish(c, 'temporary_failure', e.code, e.category, e.message, null)
        } else {
          await finish(c, 'permanent_failure', e.code, e.category, e.message, null)
        }
        // Connection-level failures: do not keep hammering the server in this run.
        if (e.phase === 'connect' || e.phase === 'greeting' || e.phase === 'auth' || e.ambiguous) halted = true
        else await transport.reset()
      }
    }
    await transport.close()
  }

  // Aggregate counts only; no addresses or content in logs.
  console.log('process-queue', JSON.stringify(summary))
  return Response.json(summary)
})
