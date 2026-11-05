import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { composeMessage, unsubscribeUrl } from '../../supabase/functions/_shared/template.ts'
import { Alert, Button, Card, Checkbox, Field, Input, Loading, Modal, PageHeader, RecipientBadge, Select, Stat, StatusBadge, TableWrap, Td, Textarea, Th } from '../components/ui'
import { useAuth } from '../lib/auth'
import { loadSettings, must, senderLabel, senderReady, useLoad } from '../lib/data'
import { toCsv } from '../lib/import'
import { dbError, supabase } from '../lib/supabase'
import { estimateMinutes, formatDuration, formatLocal, localInputs, localToUtc } from '../lib/time'
import { type Campaign, LEGAL_BASIS_LABELS, type LegalBasis, type Profile, RECIPIENT_LABELS, type Recipient, type RecipientState, type SenderAccount } from '../lib/types'

export function CampaignDetailPage() {
  const { id } = useParams()
  const { profile } = useAuth()
  const data = useLoad(async () => {
    const campaign = (await must(supabase.from('campaigns').select('*').eq('id', id!).maybeSingle())) as Campaign | null
    if (!campaign) return null
    const [recipients, sender, owner] = await Promise.all([
      must(supabase.from('campaign_recipients').select('*').eq('campaign_id', id!).order('created_at').limit(5000)),
      campaign.sender_id ? must(supabase.from('sender_accounts').select('*').eq('id', campaign.sender_id).maybeSingle()) : Promise.resolve(null),
      must(supabase.from('profiles').select('*').eq('user_id', campaign.owner_id).maybeSingle()),
    ])
    return { campaign, recipients: recipients as Recipient[], sender: sender as SenderAccount | null, owner: owner as Profile | null }
  }, [id])
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const c = data.data?.campaign
  const active = c && (c.status === 'processing' || c.status === 'scheduled')
  // Light polling while the queue is working on this campaign.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => data.reload(), 20_000)
    return () => clearInterval(t)
  }, [active, data])

  if (data.loading && !data.data) return <Loading />
  if (data.error) return <Alert tone="error">{data.error}</Alert>
  if (!data.data || !c) return <Alert tone="error">Kampaň neexistuje alebo k nej nemáte prístup.</Alert>
  const { recipients, sender, owner } = data.data
  const isOwner = c.owner_id === profile?.user_id
  const canControl = isOwner || profile?.role === 'admin'

  const count = (st: RecipientState[]) => recipients.filter((r) => st.includes(r.state)).length

  async function action(a: 'pause' | 'resume' | 'cancel' | 'unschedule') {
    const labels = { pause: 'Pozastaviť', resume: 'Pokračovať', cancel: 'Zrušiť', unschedule: 'Vrátiť do konceptu' }
    if (a === 'cancel' && !confirm('Zrušiť kampaň? Zostávajúce správy sa neodošlú. Už prijaté správy sa nedajú vrátiť.')) return
    setBusy(a)
    const { error } = await supabase.rpc('campaign_set_status', { p_campaign: c!.id, p_action: a })
    setBusy(null)
    setMsg(error ? { tone: 'error', text: dbError(error) } : { tone: 'success', text: `${labels[a]}: hotovo.` })
    data.reload()
  }

  async function resolve(r: Recipient, resolution: 'accepted' | 'failed' | 'requeue') {
    const text = {
      accepted: 'Označiť ako prijaté? Použite, ak ste správu našli v odoslanej pošte.',
      failed: 'Označiť ako neodoslané (bez ďalšieho pokusu)?',
      requeue: 'Poslať znova? Ak správa v skutočnosti odišla, príjemca ju dostane DVAKRÁT.',
    }[resolution]
    if (!confirm(text)) return
    const { error } = await supabase.rpc('recipient_resolve_unknown', { p_recipient: r.id, p_resolution: resolution })
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    data.reload()
  }

  function exportCsv() {
    const csv = toCsv(
      ['email', 'meno', 'klub', 'pozicia', 'stav', 'pokusy', 'prijate_smtp_utc', 'chyba'],
      recipients.map((r) => [r.email, r.meno, r.klub, r.pozicia, RECIPIENT_LABELS[r.state], r.attempts, r.accepted_at ?? '', r.last_error ?? '']),
    )
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${c!.name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <PageHeader
        title={c.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} /> Vytvoril {owner?.full_name || owner?.email || '–'} · {formatLocal(c.created_at)}
          </span>
        }
        actions={
          <>
            <Button onClick={() => data.reload()} busy={data.loading}>
              Obnoviť
            </Button>
            {c.status === 'draft' && isOwner && (
              <Link to={`/kampane/${c.id}/upravit`} className="inline-flex items-center rounded-md bg-white px-3.5 py-2 text-sm font-medium ring-1 ring-stone-300 hover:bg-stone-100">
                Upraviť
              </Link>
            )}
            {canControl && (c.status === 'scheduled' || c.status === 'processing') && (
              <Button onClick={() => action('pause')} busy={busy === 'pause'}>
                Pozastaviť
              </Button>
            )}
            {canControl && c.status === 'paused' && (
              <Button variant="primary" onClick={() => action('resume')} busy={busy === 'resume'}>
                Pokračovať
              </Button>
            )}
            {isOwner && !c.started_at && (c.status === 'scheduled' || c.status === 'paused') && (
              <Button onClick={() => action('unschedule')} busy={busy === 'unschedule'}>
                Vrátiť do konceptu
              </Button>
            )}
            {canControl && !['draft', 'completed', 'cancelled'].includes(c.status) && (
              <Button variant="danger" onClick={() => action('cancel')} busy={busy === 'cancel'}>
                Zrušiť kampaň
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {c.status_reason && c.status !== 'draft' && <Alert tone={c.status === 'paused' ? 'warning' : 'info'}>{c.status_reason}</Alert>}
        {sender?.blocked_until && new Date(sender.blocked_until) > new Date() && (
          <Alert tone="error" title="Odosielateľ je zablokovaný">
            Poskytovateľ odmietol odosielanie ({sender.blocked_reason}). Kým administrátor neskontroluje situáciu a odosielateľa neodblokuje, nič sa neodošle.
          </Alert>
        )}

        {c.status === 'draft' ? (
          isOwner ? (
            <ReviewAndConfirm campaign={c} recipients={recipients} sender={sender} onDone={() => data.reload()} />
          ) : (
            <Alert tone="info">Toto je koncept iného používateľa.</Alert>
          )
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Príjemcovia" value={recipients.length} />
              <Stat label="Prijaté SMTP" value={count(['accepted_by_smtp'])} hint="nie je potvrdené doručenie" />
              <Stat label="Čaká" value={count(['queued', 'processing', 'temporary_failure'])} />
              <Stat label="Zlyhalo" value={count(['permanent_failure'])} />
              <Stat label="Preskočené" value={count(['skipped_unsubscribed', 'cancelled'])} />
              <Stat label="Na kontrolu" value={count(['unknown_outcome'])} />
            </div>
            <Card title="Priebeh">
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <Info label="Odosielateľ" value={senderLabel(sender ?? undefined)} />
                <Info label="Naplánovaný začiatok" value={formatLocal(c.scheduled_at)} />
                <Info label="Skutočný začiatok" value={formatLocal(c.started_at)} />
                <Info label="Dokončené" value={formatLocal(c.completed_at)} />
                <Info label="Rýchlosť" value={`max. ${c.rate_per_minute} / min`} />
                <Info label="Právny základ" value={c.legal_basis ? LEGAL_BASIS_LABELS[c.legal_basis] : '–'} />
                <Info label="Predmet" value={c.subject} />
              </dl>
              {c.status === 'scheduled' && (
                <p className="mt-4 text-xs text-stone-500">
                  Kampaň sa môže začať spracúvať najskôr v naplánovanom čase. Plánovač beží približne raz za minútu, presný čas nie je zaručený.
                </p>
              )}
            </Card>
            {count(['unknown_outcome']) > 0 && (
              <Alert tone="warning" title="Niektoré výsledky nie sú isté">
                Pri týchto správach sa spojenie prerušilo po odoslaní obsahu, takže nevieme, či ich server prijal. Neposielajú sa automaticky znova. Skontrolujte priečinok
                Odoslané v schránke odosielateľa a rozhodnite pri každom príjemcovi.
              </Alert>
            )}
            <RecipientsTable recipients={recipients} canResolve={canControl} onResolve={resolve} onExport={exportCsv} />
          </>
        )}
      </div>
    </>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="font-medium break-words">{value}</dd>
    </div>
  )
}

function RecipientsTable({ recipients, canResolve, onResolve, onExport }: { recipients: Recipient[]; canResolve: boolean; onResolve: (r: Recipient, res: 'accepted' | 'failed' | 'requeue') => void; onExport: () => void }) {
  const [filter, setFilter] = useState<RecipientState | ''>('')
  const shown = recipients.filter((r) => !filter || r.state === filter)
  return (
    <Card
      title="Príjemcovia"
      actions={
        <>
          <Select aria-label="Filtrovať podľa stavu" value={filter} onChange={(e) => setFilter(e.target.value as RecipientState | '')} className="w-56">
            <option value="">Všetky stavy</option>
            {Object.entries(RECIPIENT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Button onClick={onExport}>Export CSV</Button>
        </>
      }
    >
      <TableWrap>
        <thead>
          <tr>
            <Th>E-mail</Th>
            <Th>Klub</Th>
            <Th>Stav</Th>
            <Th>Pokusy</Th>
            <Th>Čas</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {shown.slice(0, 1000).map((r) => (
            <tr key={r.id}>
              <Td>{r.email}</Td>
              <Td>{r.klub || '–'}</Td>
              <Td>
                <RecipientBadge state={r.state} />
              </Td>
              <Td className="tabular-nums">{r.attempts}</Td>
              <Td className="whitespace-nowrap">{formatLocal(r.accepted_at ?? r.last_attempt_at)}</Td>
              <Td className="max-w-sm">
                {r.last_error && <p className="text-xs break-words text-stone-600">{r.last_error}</p>}
                {r.state === 'temporary_failure' && r.next_attempt_at && <p className="text-xs text-stone-500">Ďalší pokus: {formatLocal(r.next_attempt_at)}</p>}
                {r.state === 'unknown_outcome' && canResolve && (
                  <div className="mt-1 flex flex-wrap gap-2 text-xs">
                    <button type="button" className="underline" onClick={() => onResolve(r, 'accepted')}>
                      Odišlo
                    </button>
                    <button type="button" className="underline" onClick={() => onResolve(r, 'failed')}>
                      Neodišlo, nechať tak
                    </button>
                    <button type="button" className="text-amber-800 underline" onClick={() => onResolve(r, 'requeue')}>
                      Poslať znova
                    </button>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </Card>
  )
}

function ReviewAndConfirm({ campaign, recipients, sender, onDone }: { campaign: Campaign; recipients: Recipient[]; sender: SenderAccount | null; onDone: () => void }) {
  const { profile } = useAuth()
  const settings = useLoad(loadSettings)
  const suppressed = useLoad(async () => {
    const emails = recipients.map((r) => r.email_normalized)
    const found = new Set<string>()
    for (let i = 0; i < emails.length; i += 200) {
      const rows = (await must(supabase.from('suppression_list').select('email_normalized').in('email_normalized', emails.slice(i, i + 200)))) as { email_normalized: string }[]
      rows.forEach((r) => found.add(r.email_normalized))
    }
    return found
  }, [recipients])

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const [now] = useState(() => localInputs(new Date(Date.now() + 15 * 60_000)))
  const [mode, setMode] = useState<'now' | 'later'>('later')
  const [date, setDate] = useState(now.date)
  const [time, setTime] = useState('08:00')
  const isAdmin = profile?.role === 'admin'
  const maxRate = Math.max(1, Math.min(sender?.rate_per_minute ?? 1, isAdmin ? 60 : settings.data?.max_member_rate_per_minute ?? 1))
  const [rate, setRate] = useState(Math.min(campaign.rate_per_minute, maxRate))
  const [basis, setBasis] = useState<LegalBasis | ''>('')
  const [note, setNote] = useState('')
  const [ack, setAck] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendable = recipients.filter((r) => !suppressed.data?.has(r.email_normalized))
  const missing = useMemo(
    () => sendable.filter((r) => composeMessage({ subject: campaign.subject, body: campaign.body_text, footer: '', unsubscribeUrl: 'https://x', data: r }).missing.length > 0).length,
    [sendable, campaign],
  )
  const unknownFields = composeMessage({ subject: campaign.subject, body: campaign.body_text, footer: '', unsubscribeUrl: 'https://x', data: {} }).unknown

  const schedule = mode === 'now' ? { status: 'ok' as const, utc: new Date(nowMs) } : localToUtc(date, time)
  const scheduleError =
    schedule.status === 'invalid'
      ? 'Neplatný dátum alebo čas.'
      : schedule.status === 'nonexistent'
        ? 'Tento čas neexistuje (prechod na letný čas). Zvoľte iný.'
        : mode === 'later' && schedule.utc.getTime() < nowMs + 60_000
          ? 'Čas začiatku musí byť v budúcnosti.'
          : null
  const startUtc = schedule.status === 'ok' || schedule.status === 'ambiguous' ? schedule.utc : null
  const minutes = estimateMinutes(sendable.length, rate, sender?.hourly_cap ?? 60, sender?.daily_cap ?? 200)
  const endEstimate = startUtc ? new Date(startUtc.getTime() + minutes * 60_000) : null

  const problems: string[] = []
  if (!sender) problems.push('Kampaň nemá vybraného odosielateľa.')
  else if (!senderReady(sender)) problems.push('Odosielateľ nie je pripravený (aktívny, heslo, úspešný test pripojenia, bez blokovania).')
  if (!campaign.subject.trim() || !campaign.body_text.trim()) problems.push('Chýba predmet alebo text správy.')
  if (sendable.length === 0) problems.push('Kampaň nemá žiadneho príjemcu, ktorému možno poslať správu.')
  if (unknownFields.length) problems.push(`Text obsahuje neznáme polia: ${unknownFields.join(', ')}.`)
  if (!/^https:\/\//.test(settings.data?.frontend_url ?? '')) problems.push('Administrátor zatiaľ nenastavil verejnú adresu aplikácie (potrebná pre odkaz na odhlásenie).')

  const canConfirm = problems.length === 0 && !scheduleError && basis && ack && (basis !== 'other_reviewed_basis' || note.trim().length >= 10)

  async function confirmSend() {
    if (!startUtc) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('campaign_confirm', {
      p_campaign: campaign.id,
      p_scheduled_at: (mode === 'now' ? new Date() : startUtc).toISOString(),
      p_rate_per_minute: rate,
      p_legal_basis: basis,
      p_legal_note: note,
      p_acknowledged: ack,
    })
    setBusy(false)
    setOpen(false)
    if (error) setError(dbError(error))
    else onDone()
  }

  const sample = sendable[0]
  const preview = composeMessage({
    subject: campaign.subject,
    body: campaign.body_text,
    footer: settings.data?.footer_text ?? '',
    unsubscribeUrl: unsubscribeUrl(settings.data?.frontend_url || window.location.href, '0'.repeat(64)),
    data: sample ?? {},
  })

  return (
    <div className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}
      {problems.length > 0 && (
        <Alert tone="error" title="Kampaň ešte nie je pripravená">
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card title="Kontrola pred odoslaním">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Info label="Odosielateľ" value={senderLabel(sender ?? undefined)} />
          <Info label="Reply-To" value={sender?.reply_to || sender?.email || '–'} />
          <Info label="Predmet" value={campaign.subject || '–'} />
          <Info label="Kontaktov v kampani" value={String(recipients.length)} />
          <Info label="Odhlásení (preskočia sa)" value={String(recipients.length - sendable.length)} />
          <Info label="Dostane samostatný e-mail" value={String(sendable.length)} />
        </dl>
        {missing > 0 && (
          <div className="mt-4">
            <Alert tone="warning">{missing} príjemcom chýbajú údaje pre použité polia – tým sa správa neodošle.</Alert>
          </div>
        )}
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium">Zobraziť náhľad správy{sample ? ` pre ${sample.email}` : ''}</summary>
          <p className="mt-3 font-medium">{preview.subject}</p>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-stone-50 p-3 font-sans whitespace-pre-wrap ring-1 ring-stone-200">{preview.body}</pre>
        </details>
      </Card>

      <Card title="Načasovanie a rýchlosť">
        <div className="space-y-4">
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="sr-only">Kedy začať</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === 'later'} onChange={() => setMode('later')} className="accent-brand-800" /> Naplánovať
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === 'now'} onChange={() => setMode('now')} className="accent-brand-800" /> Začať hneď po potvrdení
            </label>
          </fieldset>
          {mode === 'later' && (
            <div className="flex flex-wrap gap-4">
              <Field label="Dátum" htmlFor="date">
                <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Čas (Bratislava)" htmlFor="time">
                <Input id="time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
          )}
          {scheduleError && <Alert tone="error">{scheduleError}</Alert>}
          {schedule.status === 'ambiguous' && (
            <Alert tone="warning">
              Tento čas nastane dvakrát (prechod na zimný čas). Použije sa prvý výskyt: {formatLocal(schedule.utc)} letného času.
            </Alert>
          )}
          <div className="max-w-xs">
            <Field label="Rýchlosť odosielania" htmlFor="rate" hint={`Maximum pre vás: ${maxRate} / min (limit odosielateľa ${sender?.rate_per_minute ?? '–'} / min, ${sender?.hourly_cap ?? '–'} / h, ${sender?.daily_cap ?? '–'} / deň).`}>
              <Select id="rate" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                {Array.from({ length: maxRate }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} správ za minútu
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {startUtc && !scheduleError && (
            <p className="text-sm text-stone-700">
              Začiatok najskôr: <strong>{formatLocal(startUtc)}</strong>. Odhad trvania: <strong>{formatDuration(minutes)}</strong> (koniec približne {formatLocal(endEstimate)}).{' '}
              <span className="text-stone-500">Ide len o odhad – skutočný čas závisí od plánovača, ostatných kampaní toho istého odosielateľa a odpovedí poskytovateľa.</span>
            </p>
          )}
        </div>
      </Card>

      <Card title="Právny základ a potvrdenie">
        <div className="space-y-4">
          <Alert tone="info">
            Pred odoslaním overte, že oslovenie týchto adries je v súlade s pravidlami SR/EÚ (zákon o elektronických komunikáciách, GDPR) a podmienkami poskytovateľa schránky. Nie každá
            nájdená adresa smie dostať obchodnú správu. Každá správa obsahuje identifikáciu Cader a bezplatné odhlásenie.
          </Alert>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Pôvod / právny základ kontaktov" htmlFor="basis">
              <Select id="basis" value={basis} onChange={(e) => setBasis(e.target.value as LegalBasis)}>
                <option value="">– vyberte –</option>
                {Object.entries(LEGAL_BASIS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Poznámka k pôvodu kontaktov" htmlFor="note" hint={basis === 'other_reviewed_basis' ? 'Povinné pri „inom“ základe (min. 10 znakov).' : 'Napr. „verejné kontakty zo stránok klubov, november 2026“.'}>
              <Textarea id="note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="font-sans" />
            </Field>
          </div>
          <Checkbox
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            label="Potvrdzujem, že som skontroloval/a príjemcov, pôvod kontaktov a obsah správy a že odoslanie je oprávnené."
          />
          <Button variant="primary" disabled={!canConfirm} onClick={() => setOpen(true)}>
            {mode === 'now' ? 'Spustiť odosielanie…' : 'Naplánovať kampaň…'}
          </Button>
        </div>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Potvrdiť odoslanie kampane"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Späť
            </Button>
            <Button variant="primary" busy={busy} onClick={confirmSend}>
              Áno, {mode === 'now' ? 'spustiť' : 'naplánovať'}
            </Button>
          </>
        }
      >
        <p>
          <strong>{sendable.length}</strong> príjemcov dostane samostatný e-mail od <strong>{senderLabel(sender ?? undefined)}</strong>.
        </p>
        <p>
          Začiatok: <strong>{mode === 'now' ? 'hneď (do ~1 min)' : formatLocal(startUtc)}</strong>, rýchlosť max. {rate} / min.
        </p>
        <p className="text-stone-600">Kampaň môžete kedykoľvek pozastaviť alebo zrušiť. Správy, ktoré už SMTP server prijal, sa nedajú vrátiť.</p>
      </Modal>
    </div>
  )
}
