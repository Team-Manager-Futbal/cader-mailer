import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { composeMessage, unsubscribeUrl, usedFields } from '../../supabase/functions/_shared/template.ts'
import { ImportPanel } from '../components/ImportPanel'
import { Alert, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, TableWrap, Td, Textarea, Th } from '../components/ui'
import { useAuth } from '../lib/auth'
import { loadMySenders, loadSettings, must, senderLabel, senderReady, useLoad } from '../lib/data'
import type { ContactRow } from '../lib/import'
import { ApiError, callFunction, dbError, supabase } from '../lib/supabase'
import type { Campaign, Recipient, Template } from '../lib/types'

const SAMPLE_TOKEN = '0'.repeat(64)

export function CampaignEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const senders = useLoad(loadMySenders)
  const settings = useLoad(loadSettings)
  const templates = useLoad(async () => (await must(supabase.from('templates').select('*').order('name'))) as Template[])

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [loading, setLoading] = useState(Boolean(id))
  const [form, setForm] = useState({ name: '', sender_id: '', subject: '', body_text: '' })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const [previewIdx, setPreviewIdx] = useState(0)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  async function loadCampaign() {
    if (!id) return
    setLoading(true)
    const { data, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle()
    if (error || !data) {
      setMsg({ tone: 'error', text: error ? dbError(error) : 'Kampaň neexistuje alebo k nej nemáte prístup.' })
      setLoading(false)
      return
    }
    const c = data as Campaign
    setCampaign(c)
    setForm({ name: c.name, sender_id: c.sender_id ?? '', subject: c.subject, body_text: c.body_text })
    const { data: rs } = await supabase.from('campaign_recipients').select('*').eq('campaign_id', id).order('created_at').limit(5000)
    setRecipients((rs ?? []) as Recipient[])
    setLoading(false)
  }

  useEffect(() => {
    loadCampaign()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Default the sender for a new campaign.
  useEffect(() => {
    if (!id && !form.sender_id && senders.data?.length) setForm((f) => ({ ...f, sender_id: senders.data![0].id }))
  }, [id, senders.data, form.sender_id])

  const editable = !campaign || (campaign.status === 'draft' && campaign.owner_id === profile?.user_id)
  const sender = senders.data?.find((s) => s.id === form.sender_id)

  async function save(): Promise<string | null> {
    if (!form.name.trim()) {
      setMsg({ tone: 'error', text: 'Zadajte názov kampane.' })
      return null
    }
    setSaving(true)
    setMsg(null)
    const payload = {
      name: form.name.trim(),
      sender_id: form.sender_id || null,
      subject: form.subject,
      body_text: form.body_text,
    }
    const res = campaign
      ? await supabase.from('campaigns').update(payload).eq('id', campaign.id).select().single()
      : await supabase.from('campaigns').insert({ ...payload, owner_id: profile!.user_id }).select().single()
    setSaving(false)
    if (res.error) {
      setMsg({ tone: 'error', text: dbError(res.error) })
      return null
    }
    const c = res.data as Campaign
    setCampaign(c)
    setMsg({ tone: 'success', text: 'Koncept uložený.' })
    if (!id) navigate(`/kampane/${c.id}/upravit`, { replace: true })
    return c.id
  }

  async function importRows(rows: ContactRow[]) {
    const cid = campaign?.id ?? (await save())
    if (!cid) throw new Error('Najprv uložte koncept.')
    const { data, error } = await supabase.rpc('campaign_set_recipients', { p_campaign: cid, p_rows: rows, p_replace: false })
    if (error) throw new Error(dbError(error))
    const r = data as { added: number; invalid: number; duplicate: number; suppressed: number; total: number }
    setMsg({
      tone: 'success',
      text: `Pridaných ${r.added} príjemcov (server odmietol: ${r.invalid} neplatných, ${r.duplicate} duplicít, ${r.suppressed} odhlásených). Spolu ${r.total}.`,
    })
    await loadCampaign()
  }

  async function removeRecipient(rid: string) {
    const { error } = await supabase.from('campaign_recipients').delete().eq('id', rid)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    else setRecipients((rs) => rs.filter((r) => r.id !== rid))
  }

  async function removeAll() {
    if (!campaign || !confirm('Odstrániť všetkých príjemcov z tejto kampane?')) return
    const { error } = await supabase.from('campaign_recipients').delete().eq('campaign_id', campaign.id)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    else setRecipients([])
  }

  function insertPlaceholder(p: string) {
    const el = bodyRef.current
    const token = `{${p}}`
    if (!el) return setForm((f) => ({ ...f, body_text: f.body_text + token }))
    const { selectionStart: s, selectionEnd: e } = el
    const next = form.body_text.slice(0, s) + token + form.body_text.slice(e)
    setForm((f) => ({ ...f, body_text: next }))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + token.length, s + token.length)
    })
  }

  function applyTemplate(tid: string) {
    const t = templates.data?.find((x) => x.id === tid)
    if (!t) return
    if ((form.subject || form.body_text) && !confirm('Prepísať predmet a text šablónou?')) return
    setForm((f) => ({ ...f, subject: t.subject, body_text: t.body_text }))
  }

  async function saveAsTemplate() {
    const name = prompt('Názov šablóny (napr. „Prvé oslovenie klubu“):')
    if (!name?.trim()) return
    const { error } = await supabase
      .from('templates')
      .insert({ owner_id: profile!.user_id, name: name.trim(), subject: form.subject, body_text: form.body_text, shared: true })
    setMsg(error ? { tone: 'error', text: dbError(error) } : { tone: 'success', text: 'Šablóna uložená.' })
    templates.reload()
  }

  const sample = recipients[Math.min(previewIdx, Math.max(0, recipients.length - 1))]
  const preview = useMemo(
    () =>
      composeMessage({
        subject: form.subject,
        body: form.body_text,
        footer: settings.data?.footer_text ?? '',
        unsubscribeUrl: unsubscribeUrl(settings.data?.frontend_url || window.location.href, SAMPLE_TOKEN),
        data: sample ?? {},
      }),
    [form.subject, form.body_text, settings.data, sample],
  )
  // Missing values across ALL recipients (each one will be refused at send time).
  const missingCount = useMemo(() => {
    const fields = usedFields(form.subject + form.body_text)
    return recipients.filter((r) => {
      const m = composeMessage({ subject: form.subject, body: form.body_text, footer: '', unsubscribeUrl: 'https://x', data: r })
      return m.missing.length > 0 && fields.length > 0
    }).length
  }, [recipients, form.subject, form.body_text])

  if (loading) return <Loading />

  if (campaign && !editable) {
    return (
      <>
        <PageHeader title={campaign.name} />
        <Alert tone="info">
          Kampaň už nie je koncept, preto sa nedá upravovať.{' '}
          <Link className="underline" to={`/kampane/${campaign.id}`}>
            Prejsť na detail kampane
          </Link>
        </Alert>
      </>
    )
  }

  const noSenders = senders.data && senders.data.length === 0

  return (
    <>
      <PageHeader
        title={campaign ? `Upraviť: ${campaign.name}` : 'Nová kampaň'}
        description="Koncept sa nikomu neposiela. Odoslanie sa naplánuje až po kontrole a výslovnom potvrdení."
        actions={
          campaign && (
            <Link to={`/kampane/${campaign.id}`} className="inline-flex items-center rounded-md bg-brand-800 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-900">
              Pokračovať na kontrolu a plánovanie
            </Link>
          )
        }
      />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {noSenders && (
          <Alert tone="warning" title="Nemáte prideleného žiadneho odosielateľa">
            Koncept môžete pripraviť, ale na odoslanie vám administrátor musí prideliť odosielateľskú schránku.
          </Alert>
        )}

        <Card
          title="1. Správa"
          actions={
            <>
              {templates.data && templates.data.length > 0 && (
                <Select aria-label="Načítať šablónu" value="" onChange={(e) => applyTemplate(e.target.value)} className="w-52">
                  <option value="">Načítať šablónu…</option>
                  {templates.data.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button onClick={saveAsTemplate} disabled={!form.body_text}>
                Uložiť ako šablónu
              </Button>
            </>
          }
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Názov kampane (interný)" htmlFor="name">
              <Input id="name" value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Oslovenie klubov – Západ" />
            </Field>
            <Field
              label="Odosielateľ"
              htmlFor="sender"
              hint={sender && !senderReady(sender) ? 'Odosielateľ zatiaľ nie je pripravený na odosielanie (admin musí nastaviť heslo a otestovať pripojenie).' : sender?.reply_to ? `Odpovede pôjdu na ${sender.reply_to}` : undefined}
            >
              <Select id="sender" value={form.sender_id} onChange={(e) => setForm({ ...form, sender_id: e.target.value })}>
                <option value="">– vyberte –</option>
                {senders.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {senderLabel(s)}
                    {senderReady(s) ? '' : ' (nepripravený)'}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="md:col-span-2">
              <Field label="Predmet" htmlFor="subject">
                <Input id="subject" value={form.subject} maxLength={500} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Spolupráca s {klub|vaším klubom}" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field
                label="Text správy (čistý text)"
                htmlFor="body"
                hint={
                  <>
                    Polia: <code>{'{meno}'}</code>, <code>{'{klub}'}</code>, <code>{'{pozicia}'}</code>. Náhradná hodnota pri chýbajúcom údaji: <code>{'{meno|pán tréner}'}</code>. Podpis (pätička z Nastavení) sa pridá automaticky, do textu ho nepíšte.
                  </>
                }
              >
                <div className="mb-2 flex flex-wrap gap-2">
                  {['meno', 'klub', 'pozicia'].map((p) => (
                    <Button key={p} variant="ghost" className="px-2 py-1 text-xs ring-1 ring-stone-300" onClick={() => insertPlaceholder(p)}>
                      + {`{${p}}`}
                    </Button>
                  ))}
                </div>
                <Textarea id="body" ref={bodyRef} rows={12} value={form.body_text} maxLength={50000} onChange={(e) => setForm({ ...form, body_text: e.target.value })} />
              </Field>
            </div>
          </div>
          <div className="mt-4">
            <Button variant="primary" busy={saving} onClick={save}>
              {campaign ? 'Uložiť zmeny' : 'Uložiť koncept'}
            </Button>
          </div>
        </Card>

        <Card
          title={`2. Príjemcovia${recipients.length ? ` (${recipients.length})` : ''}`}
          actions={recipients.length > 0 && <Button variant="ghost" onClick={removeAll}>Odstrániť všetkých</Button>}
        >
          {!campaign ? (
            <p className="text-sm text-stone-600">Príjemcov môžete pridať po uložení konceptu (alebo sa koncept uloží automaticky pri importe).</p>
          ) : null}
          <ImportPanel existing={recipients.map((r) => r.email_normalized)} onImport={importRows} />
          {recipients.length > 0 && (
            <div className="mt-6 max-h-96 overflow-auto">
              <TableWrap>
                <thead className="sticky top-0 bg-white">
                  <tr>
                    <Th>E-mail</Th>
                    <Th>Meno</Th>
                    <Th>Klub</Th>
                    <Th>Pozícia</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {recipients.map((r, i) => (
                    <tr key={r.id}>
                      <Td>{r.email}</Td>
                      <Td>{r.meno || <span className="text-stone-400">–</span>}</Td>
                      <Td>{r.klub || <span className="text-stone-400">–</span>}</Td>
                      <Td>{r.pozicia || <span className="text-stone-400">–</span>}</Td>
                      <Td className="text-right whitespace-nowrap">
                        <button type="button" className="mr-3 text-xs text-stone-600 underline" onClick={() => setPreviewIdx(i)}>
                          Náhľad
                        </button>
                        <button type="button" className="text-xs text-red-700 underline" onClick={() => removeRecipient(r.id)}>
                          Odstrániť
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          )}
        </Card>

        <Card title="3. Náhľad pre príjemcu">
          {recipients.length > 0 && (
            <div className="mb-4 max-w-md">
              <Field label="Príjemca náhľadu" htmlFor="preview-recipient">
                <Select id="preview-recipient" value={Math.min(previewIdx, recipients.length - 1)} onChange={(e) => setPreviewIdx(Number(e.target.value))}>
                  {recipients.slice(0, 500).map((r, i) => (
                    <option key={r.id} value={i}>
                      {r.email}
                      {r.klub ? ` – ${r.klub}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {(preview.missing.length > 0 || preview.unknown.length > 0 || missingCount > 0) && (
            <div className="mb-4 space-y-2">
              {preview.unknown.length > 0 && (
                <Alert tone="error">Neznáme polia: {preview.unknown.map((u) => `{${u}}`).join(', ')}. Povolené sú {'{meno}'}, {'{klub}'}, {'{pozicia}'}.</Alert>
              )}
              {preview.missing.length > 0 && <Alert tone="warning">Tento príjemca nemá hodnotu pre: {preview.missing.join(', ')}. Doplňte údaje alebo náhradnú hodnotu, napr. {'{meno|pán tréner}'}.</Alert>}
              {missingCount > 0 && (
                <Alert tone="warning">
                  {missingCount} príjemcom chýbajú údaje pre použité polia. Týmto príjemcom sa správa neodošle (budú označení ako zlyhané).
                </Alert>
              )}
            </div>
          )}
          <div className="overflow-hidden rounded-md ring-1 ring-stone-200">
            <dl className="divide-y divide-stone-100 bg-stone-50 text-sm">
              <div className="flex gap-3 px-4 py-2">
                <dt className="w-20 shrink-0 text-stone-500">Od</dt>
                <dd>{sender ? senderLabel(sender) : '–'}</dd>
              </div>
              <div className="flex gap-3 px-4 py-2">
                <dt className="w-20 shrink-0 text-stone-500">Komu</dt>
                <dd>{sample?.email ?? 'príjemca@example.com'} (každý príjemca dostane samostatný e-mail)</dd>
              </div>
              <div className="flex gap-3 px-4 py-2">
                <dt className="w-20 shrink-0 text-stone-500">Predmet</dt>
                <dd className="font-medium">{preview.subject || <span className="text-stone-400">(bez predmetu)</span>}</dd>
              </div>
            </dl>
            <pre className="max-h-[32rem] overflow-auto bg-white px-4 py-4 font-sans text-sm leading-relaxed whitespace-pre-wrap">{preview.body}</pre>
          </div>
        </Card>

        {campaign && sender && (
          <TestSendCard senderId={sender.id} ready={sender.active && sender.credential_set} defaultTo={profile?.email ?? ''} subject={form.subject} body={form.body_text} merge={sample} />
        )}
      </div>
    </>
  )
}

function TestSendCard({ senderId, ready, defaultTo, subject, body, merge }: { senderId: string; ready: boolean; defaultTo: string; subject: string; body: string; merge?: Recipient }) {
  const [to, setTo] = useState(defaultTo)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function send() {
    setBusy(true)
    setResult(null)
    try {
      const r = await callFunction<{ ok: boolean; message: string }>('send-test', {
        sender_id: senderId,
        to: to.trim(),
        subject,
        body,
        merge: merge ? { meno: merge.meno, klub: merge.klub, pozicia: merge.pozicia } : {},
        confirmed: true,
      })
      setResult(r)
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : 'Test zlyhal.' })
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <Card title="4. Testovací e-mail">
      <p className="mb-4 text-sm text-stone-600">
        Pošle presne <strong>jednu</strong> správu označenú „[TEST]“ na vašu adresu (alebo adresu schválenú adminom). Nie je súčasťou kampane. Údaje polí sa použijú z príjemcu náhľadu.
      </p>
      {!ready && <Alert tone="warning">Odosielateľ nie je aktívny alebo nemá uložené heslo.</Alert>}
      {result && (
        <div className="mb-4">
          <Alert tone={result.ok ? 'success' : 'error'}>{result.message}</Alert>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-sm">
          <Field label="Príjemca testu" htmlFor="test-to">
            <Input id="test-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!ready || !to || !subject || !body}>
          Poslať test…
        </Button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Poslať testovací e-mail?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Zrušiť
            </Button>
            <Button variant="primary" busy={busy} onClick={send}>
              Áno, poslať 1 test
            </Button>
          </>
        }
      >
        <p>
          Odošle sa jedna testovacia správa na <strong>{to}</strong> cez skutočnú SMTP schránku odosielateľa. Započíta sa do limitov odosielateľa.
        </p>
      </Modal>
    </Card>
  )
}
