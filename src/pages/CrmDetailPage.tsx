import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DueBadge, StageBadge } from '../components/crm'
import { Alert, Button, Card, Field, Input, Loading, PageHeader, Select, Textarea, cx } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  type Account,
  type AccountContact,
  type AccountType,
  type Activity,
  ACTIVITY_LABELS,
  type ActivityKind,
  type DealStage,
  MANUAL_KINDS,
  STAGE_LABELS,
  STAGES,
  todayLocal,
  TYPE_LABELS,
} from '../lib/crm'
import { must, useLoad } from '../lib/data'
import { isValidEmail } from '../lib/emails'
import { dbError, supabase } from '../lib/supabase'
import { formatLocal, localToUtc } from '../lib/time'
import type { Profile } from '../lib/types'

export function CrmDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const data = useLoad(async () => {
    const [account, contacts, activities, profiles] = await Promise.all([
      must(supabase.from('accounts').select('*').eq('id', id!).maybeSingle()),
      must(supabase.from('account_contacts').select('*').eq('account_id', id!).order('created_at')),
      must(supabase.from('account_activities').select('*').eq('account_id', id!).order('happened_at', { ascending: false }).limit(500)),
      must(supabase.from('profiles').select('user_id, full_name, email, active')),
    ])
    return {
      account: account as Account | null,
      contacts: contacts as AccountContact[],
      activities: activities as Activity[],
      profiles: profiles as Profile[],
    }
  }, [id])
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  if (data.loading && !data.data) return <Loading />
  if (data.error) return <Alert tone="error">{data.error}</Alert>
  const a = data.data?.account
  if (!a) return <Alert tone="error">Záznam neexistuje.</Alert>
  const people = new Map(data.data!.profiles.map((p) => [p.user_id, p.full_name || p.email]))

  async function update(patch: Partial<Account>, ok?: string) {
    const { error } = await supabase.from('accounts').update(patch).eq('id', a!.id)
    setMsg(error ? { tone: 'error', text: error.code === '23505' ? 'Záznam s týmto názvom už existuje.' : dbError(error) } : ok ? { tone: 'success', text: ok } : null)
    await data.reload()
  }

  async function remove() {
    if (!confirm(`Natrvalo odstrániť „${a!.name}“ aj s osobami a históriou?`)) return
    const { error } = await supabase.from('accounts').delete().eq('id', a!.id)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    else navigate('/kluby')
  }

  return (
    <>
      <PageHeader
        title={a.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {TYPE_LABELS[a.type]} · <StageBadge stage={a.stage} /> od {formatLocal(a.stage_changed_at)}
          </span>
        }
        actions={
          <>
            <Link to="/kluby" className="inline-flex items-center rounded-md bg-white px-3.5 py-2 text-sm font-medium ring-1 ring-stone-300 hover:bg-stone-100">
              Späť na zoznam
            </Link>
            {isAdmin && (
              <Button variant="ghost" onClick={remove}>
                Odstrániť
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-6">
            <StageCard account={a} onChange={(stage) => update({ stage }, `Stav zmenený na „${STAGE_LABELS[stage]}“.`)} />
            <ActivityCard
              accountId={a.id}
              activities={data.data!.activities}
              people={people}
              canDelete={(x) => MANUAL_KINDS.includes(x.kind) && (x.author_id === profile?.user_id || isAdmin)}
              onChanged={() => data.reload()}
            />
          </div>
          <div className="space-y-6">
            <NextStepCard account={a} onSave={(patch, ok) => update(patch, ok)} />
            <ContactsCard accountId={a.id} contacts={data.data!.contacts} onChanged={() => data.reload()} />
            <DetailsCard account={a} profiles={data.data!.profiles} onSave={(patch) => update(patch, 'Uložené.')} />
          </div>
        </div>
      </div>
    </>
  )
}

function StageCard({ account, onChange }: { account: Account; onChange: (s: DealStage) => void }) {
  return (
    <Card title="Stav obchodu">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Zmeniť stav">
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={account.stage === s}
            onClick={() => account.stage !== s && onChange(s)}
            className={cx(
              'rounded-md px-3 py-1.5 text-sm font-medium ring-1',
              account.stage === s ? 'bg-brand-800 text-white ring-brand-800' : 'bg-white text-stone-700 ring-stone-300 hover:bg-stone-100',
            )}
          >
            {STAGE_LABELS[s]}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-stone-500">Každá zmena stavu sa zapíše do histórie. Kluby v stave Odpovedal, Stretnutie, Podmienky, Klient a Nemá záujem sa pri importe do ďalšej kampane predvolene vynechajú.</p>
    </Card>
  )
}

function NextStepCard({ account, onSave }: { account: Account; onSave: (patch: Partial<Account>, ok: string) => Promise<void> }) {
  const [date, setDate] = useState(account.next_action_on ?? '')
  const [note, setNote] = useState(account.next_action_note ?? '')
  useEffect(() => {
    setDate(account.next_action_on ?? '')
    setNote(account.next_action_note ?? '')
  }, [account.next_action_on, account.next_action_note])
  const changed = date !== (account.next_action_on ?? '') || note !== (account.next_action_note ?? '')
  const quick = (days: number) => {
    const d = new Date(`${todayLocal()}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    setDate(d.toISOString().slice(0, 10))
  }
  return (
    <Card title="Ďalší krok">
      <div className="space-y-3">
        {account.next_action_on && (
          <div className="flex items-center gap-2 text-sm">
            <DueBadge date={account.next_action_on} />
          </div>
        )}
        <Field label="Kedy" htmlFor="next-date">
          <Input id="next-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            ['Zajtra', 1],
            ['O 3 dni', 3],
            ['O týždeň', 7],
            ['O 2 týždne', 14],
          ].map(([l, d]) => (
            <button key={l} type="button" className="rounded px-2 py-1 ring-1 ring-stone-300 hover:bg-stone-100" onClick={() => quick(d as number)}>
              {l}
            </button>
          ))}
        </div>
        <Field label="Čo urobiť" htmlFor="next-note">
          <Input id="next-note" value={note} maxLength={500} placeholder="napr. zavolať predsedovi, poslať ponuku" onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!changed} onClick={() => onSave({ next_action_on: date || null, next_action_note: note.trim() || null }, 'Ďalší krok uložený.')}>
            Uložiť
          </Button>
          {account.next_action_on && (
            <Button onClick={() => onSave({ next_action_on: null, next_action_note: null }, 'Ďalší krok označený ako hotový.')}>Hotovo</Button>
          )}
        </div>
      </div>
    </Card>
  )
}

function ContactsCard({ accountId, contacts, onChanged }: { accountId: string; contacts: AccountContact[]; onChanged: () => void }) {
  const empty = { full_name: '', role: '', email: '', phone: '', note: '' }
  const [edit, setEdit] = useState<(typeof empty & { id?: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!edit) return
    if (edit.email && !isValidEmail(edit.email)) return setError('Neplatný e-mail.')
    if (!edit.full_name.trim() && !edit.email.trim() && !edit.phone.trim()) return setError('Vyplňte meno, e-mail alebo telefón.')
    const payload = {
      full_name: edit.full_name.trim(),
      role: edit.role.trim(),
      email: edit.email.trim() || null,
      phone: edit.phone.trim(),
      note: edit.note.trim() || null,
    }
    const { error: e } = edit.id
      ? await supabase.from('account_contacts').update(payload).eq('id', edit.id)
      : await supabase.from('account_contacts').insert({ ...payload, account_id: accountId })
    if (e) return setError(e.code === '23505' ? 'Tento e-mail už pri klube je.' : dbError(e))
    setEdit(null)
    setError(null)
    onChanged()
  }

  async function remove(c: AccountContact) {
    if (!confirm(`Odstrániť kontakt ${c.full_name || c.email}?`)) return
    await supabase.from('account_contacts').delete().eq('id', c.id)
    onChanged()
  }

  return (
    <Card title={`Osoby (${contacts.length})`} actions={!edit && <Button variant="ghost" onClick={() => setEdit(empty)}>Pridať</Button>}>
      <div className="space-y-3">
        {contacts.length === 0 && !edit && <p className="text-sm text-stone-600">Zatiaľ žiadne osoby.</p>}
        {contacts.map((c) => (
          <div key={c.id} className="rounded-md p-3 text-sm ring-1 ring-stone-200">
            <p className="font-medium">{c.full_name || <span className="text-stone-400">bez mena</span>}</p>
            {c.role && <p className="text-xs text-stone-500">{c.role}</p>}
            {c.email && (
              <a href={`mailto:${c.email}`} className="block break-all text-brand-800 underline-offset-2 hover:underline">
                {c.email}
              </a>
            )}
            {c.phone && (
              <a href={`tel:${c.phone.replace(/\s+/g, '')}`} className="block text-brand-800 underline-offset-2 hover:underline">
                {c.phone}
              </a>
            )}
            {c.note && <p className="mt-1 text-xs text-stone-600">{c.note}</p>}
            <div className="mt-2 flex gap-3 text-xs">
              <button type="button" className="underline" onClick={() => setEdit({ id: c.id, full_name: c.full_name, role: c.role, email: c.email ?? '', phone: c.phone, note: c.note ?? '' })}>
                Upraviť
              </button>
              <button type="button" className="text-red-700 underline" onClick={() => remove(c)}>
                Odstrániť
              </button>
            </div>
          </div>
        ))}
        {edit && (
          <div className="space-y-3 rounded-md bg-stone-50 p-3 ring-1 ring-stone-200">
            {error && <Alert tone="error">{error}</Alert>}
            <Field label="Meno" htmlFor="c-name">
              <Input id="c-name" value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} />
            </Field>
            <Field label="Funkcia" htmlFor="c-role">
              <Input id="c-role" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} />
            </Field>
            <Field label="E-mail" htmlFor="c-email">
              <Input id="c-email" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
            </Field>
            <Field label="Telefón" htmlFor="c-phone">
              <Input id="c-phone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
            </Field>
            <Field label="Poznámka" htmlFor="c-note">
              <Input id="c-note" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" onClick={save}>
                Uložiť
              </Button>
              <Button variant="ghost" onClick={() => { setEdit(null); setError(null) }}>
                Zrušiť
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function DetailsCard({ account, profiles, onSave }: { account: Account; profiles: Profile[]; onSave: (patch: Partial<Account>) => Promise<void> }) {
  const [form, setForm] = useState({
    name: account.name,
    type: account.type,
    owner_id: account.owner_id ?? '',
    website: account.website ?? '',
    region: account.region ?? '',
    terms: account.terms ?? '',
  })
  useEffect(() => {
    setForm({
      name: account.name,
      type: account.type,
      owner_id: account.owner_id ?? '',
      website: account.website ?? '',
      region: account.region ?? '',
      terms: account.terms ?? '',
    })
  }, [account])
  return (
    <Card title="Údaje a dohodnuté podmienky">
      <div className="space-y-3">
        <Field label="Dohodnuté podmienky / stretnutie" htmlFor="d-terms" hint="Napr. termín a miesto stretnutia, cena, počet čipov, bezplatné obdobie.">
          <Textarea id="d-terms" rows={5} className="font-sans" value={form.terms} maxLength={5000} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
        </Field>
        <Field label="Názov" htmlFor="d-name">
          <Input id="d-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Typ" htmlFor="d-type">
          <Select id="d-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AccountType })}>
            <option value="club">Klub</option>
            <option value="partner">Partner / sponzor</option>
          </Select>
        </Field>
        <Field label="Zodpovedný" htmlFor="d-owner">
          <Select id="d-owner" value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })}>
            <option value="">– nikto –</option>
            {profiles
              .filter((p) => p.active || p.user_id === form.owner_id)
              .map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.full_name || p.email}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Web" htmlFor="d-web">
          <Input id="d-web" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" />
        </Field>
        <Field label="Región / liga" htmlFor="d-region">
          <Input id="d-region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
        </Field>
        <Button
          variant="primary"
          disabled={!form.name.trim()}
          onClick={() =>
            onSave({
              name: form.name.trim(),
              type: form.type,
              owner_id: form.owner_id || null,
              website: form.website.trim() || null,
              region: form.region.trim() || null,
              terms: form.terms.trim() || null,
            })
          }
        >
          Uložiť
        </Button>
      </div>
    </Card>
  )
}

function ActivityCard({
  accountId,
  activities,
  people,
  canDelete,
  onChanged,
}: {
  accountId: string
  activities: Activity[]
  people: Map<string, string>
  canDelete: (a: Activity) => boolean
  onChanged: () => void
}) {
  const { profile } = useAuth()
  const [kind, setKind] = useState<ActivityKind>('note')
  const [body, setBody] = useState('')
  const [date, setDate] = useState(todayLocal())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    if (!body.trim()) return
    const when = date === todayLocal() ? new Date() : (() => {
      const r = localToUtc(date, '12:00')
      return r.status === 'ok' || r.status === 'ambiguous' ? r.utc : new Date()
    })()
    setBusy(true)
    const { error: e } = await supabase
      .from('account_activities')
      .insert({ account_id: accountId, author_id: profile!.user_id, kind, body: body.trim(), happened_at: when.toISOString() })
    setBusy(false)
    if (e) return setError(dbError(e))
    setBody('')
    setError(null)
    onChanged()
  }

  async function remove(a: Activity) {
    if (!confirm('Odstrániť tento záznam z histórie?')) return
    await supabase.from('account_activities').delete().eq('id', a.id)
    onChanged()
  }

  const describe = (a: Activity) => {
    if (a.kind === 'stage_change') {
      const m = a.meta as { from?: keyof typeof STAGE_LABELS; to?: keyof typeof STAGE_LABELS }
      return `${m.from ? STAGE_LABELS[m.from] : '?'} → ${m.to ? STAGE_LABELS[m.to] : '?'}`
    }
    return a.body
  }

  return (
    <Card title="História">
      <div className="space-y-3 rounded-md bg-stone-50 p-3 ring-1 ring-stone-200">
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Typ záznamu">
          {MANUAL_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cx('rounded-md px-2.5 py-1 text-sm ring-1', kind === k ? 'bg-brand-800 text-white ring-brand-800' : 'bg-white ring-stone-300 hover:bg-stone-100')}
            >
              {ACTIVITY_LABELS[k]}
            </button>
          ))}
        </div>
        <Textarea
          aria-label="Text záznamu"
          rows={3}
          className="font-sans"
          value={body}
          placeholder={kind === 'call' ? 'O čom ste hovorili, na čom ste sa dohodli…' : kind === 'meeting' ? 'Kde, kto, výsledok stretnutia…' : 'Poznámka…'}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Dátum" htmlFor="act-date">
            <Input id="act-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Button variant="primary" busy={busy} disabled={!body.trim()} onClick={add}>
            Pridať do histórie
          </Button>
        </div>
      </div>
      <ol className="mt-5 space-y-4">
        {activities.length === 0 && <li className="text-sm text-stone-600">Zatiaľ bez záznamov.</li>}
        {activities.map((a) => (
          <li key={a.id} className="border-l-2 border-stone-200 pl-4">
            <p className="text-xs text-stone-500">
              <span className="font-semibold text-stone-700">{ACTIVITY_LABELS[a.kind]}</span> · {formatLocal(a.happened_at)}
              {a.author_id ? ` · ${people.get(a.author_id) ?? ''}` : a.kind === 'stage_change' ? ' · systém' : ''}
            </p>
            <p className="mt-0.5 text-sm whitespace-pre-wrap">{describe(a)}</p>
            {canDelete(a) && (
              <button type="button" className="mt-1 text-xs text-stone-500 underline" onClick={() => remove(a)}>
                Odstrániť
              </button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}
