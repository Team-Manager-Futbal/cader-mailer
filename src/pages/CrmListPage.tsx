import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DueBadge, StageBadge } from '../components/crm'
import { Alert, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, TableWrap, Td, Th, cx } from '../components/ui'
import { useAuth } from '../lib/auth'
import { type Account, type AccountContact, type AccountType, dueState, STAGE_LABELS, STAGES, type DealStage, TYPE_LABELS } from '../lib/crm'
import { must, useLoad } from '../lib/data'
import { isValidEmail } from '../lib/emails'
import { dbError, supabase } from '../lib/supabase'
import { formatLocal } from '../lib/time'
import type { Profile } from '../lib/types'

interface Row extends Account {
  account_contacts: Pick<AccountContact, 'full_name' | 'email' | 'phone'>[]
  account_activities: { happened_at: string }[]
}

export function CrmListPage() {
  const data = useLoad(async () => {
    const [accounts, profiles] = await Promise.all([
      must(
        supabase
          .from('accounts')
          .select('*, account_contacts(full_name, email, phone), account_activities(happened_at)')
          .order('happened_at', { referencedTable: 'account_activities', ascending: false })
          .limit(1, { referencedTable: 'account_activities' })
          .order('name'),
      ),
      must(supabase.from('profiles').select('user_id, full_name, email')),
    ])
    return { accounts: accounts as Row[], profiles: new Map((profiles as Profile[]).map((p) => [p.user_id, p])) }
  })
  const [type, setType] = useState<AccountType | ''>('club')
  const [stage, setStage] = useState<DealStage | ''>('')
  const [due, setDue] = useState<'' | 'due' | 'any'>('')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (data.data?.accounts ?? []).filter((a) => {
      if (type && a.type !== type) return false
      if (stage && a.stage !== stage) return false
      const d = dueState(a.next_action_on)
      if (due === 'due' && d !== 'overdue' && d !== 'today') return false
      if (due === 'any' && !a.next_action_on) return false
      if (term) {
        const hay = [a.name, ...a.account_contacts.flatMap((c) => [c.full_name, c.email ?? ''])].join(' ').toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }, [data.data, type, stage, due, q])

  const counts = useMemo(() => {
    const m = new Map<DealStage, number>()
    for (const a of data.data?.accounts ?? []) if (!type || a.type === type) m.set(a.stage, (m.get(a.stage) ?? 0) + 1)
    return m
  }, [data.data, type])

  return (
    <>
      <PageHeader
        title="Kluby a partneri"
        description="Stav obchodu, ďalšie kroky a história pri každom klube. Kluby z odoslaných kampaní sa sem pridávajú automaticky."
        actions={
          <>
            <Button onClick={() => data.reload()} busy={data.loading}>
              Obnoviť
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              Pridať klub / partnera
            </Button>
          </>
        }
      />
      {data.error && <Alert tone="error">{data.error}</Alert>}
      {data.loading && !data.data && <Loading />}
      {data.data && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrovať podľa stavu">
            <StageChip active={stage === ''} onClick={() => setStage('')} label="Všetky" count={[...counts.values()].reduce((a, b) => a + b, 0)} />
            {STAGES.map((s) => (
              <StageChip key={s} active={stage === s} onClick={() => setStage(stage === s ? '' : s)} label={STAGE_LABELS[s]} count={counts.get(s) ?? 0} />
            ))}
          </div>
          <Card
            title={`${filtered.length} záznamov`}
            actions={
              <>
                <Input aria-label="Hľadať" placeholder="Hľadať klub, osobu, e-mail…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
                <Select aria-label="Typ" value={type} onChange={(e) => setType(e.target.value as AccountType | '')} className="w-44">
                  <option value="club">Kluby</option>
                  <option value="partner">Partneri / sponzori</option>
                  <option value="">Všetko</option>
                </Select>
                <Select aria-label="Ďalší krok" value={due} onChange={(e) => setDue(e.target.value as '' | 'due' | 'any')} className="w-48">
                  <option value="">Všetky termíny</option>
                  <option value="due">Dnes a po termíne</option>
                  <option value="any">S naplánovaným krokom</option>
                </Select>
              </>
            }
          >
            {filtered.length === 0 ? (
              <Empty title="Nič sa nenašlo">Skúste zmeniť filter alebo pridajte nový záznam.</Empty>
            ) : (
              <TableWrap>
                <thead>
                  <tr>
                    <Th>{type === 'partner' ? 'Partner' : 'Klub'}</Th>
                    <Th>Stav</Th>
                    <Th>Ďalší krok</Th>
                    <Th>Kontakt</Th>
                    <Th>Posledná aktivita</Th>
                    <Th>Zodpovedný</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {filtered.map((a) => {
                    const c = a.account_contacts[0]
                    const owner = a.owner_id ? data.data!.profiles.get(a.owner_id) : undefined
                    return (
                      <tr key={a.id} className="hover:bg-stone-50">
                        <Td>
                          <Link to={`/kluby/${a.id}`} className="font-medium underline-offset-2 hover:underline">
                            {a.name}
                          </Link>
                          {!type && <p className="text-xs text-stone-500">{TYPE_LABELS[a.type]}</p>}
                        </Td>
                        <Td>
                          <StageBadge stage={a.stage} />
                        </Td>
                        <Td className="max-w-64">
                          {a.next_action_on ? (
                            <>
                              <DueBadge date={a.next_action_on} />
                              {a.next_action_note && <p className="mt-0.5 truncate text-xs text-stone-600">{a.next_action_note}</p>}
                            </>
                          ) : (
                            <span className="text-stone-400">–</span>
                          )}
                        </Td>
                        <Td className="max-w-56">
                          {c ? (
                            <>
                              <p className="truncate">{c.full_name || c.email}</p>
                              {c.full_name && c.email && <p className="truncate text-xs text-stone-500">{c.email}</p>}
                            </>
                          ) : (
                            <span className="text-stone-400">–</span>
                          )}
                          {a.account_contacts.length > 1 && <p className="text-xs text-stone-500">+{a.account_contacts.length - 1} ďalší</p>}
                        </Td>
                        <Td className="whitespace-nowrap">{formatLocal(a.account_activities[0]?.happened_at)}</Td>
                        <Td className="whitespace-nowrap">{owner?.full_name || owner?.email || '–'}</Td>
                      </tr>
                    )
                  })}
                </tbody>
              </TableWrap>
            )}
          </Card>
        </div>
      )}
      <AddAccountModal open={adding} onClose={() => setAdding(false)} defaultType={type || 'club'} />
    </>
  )
}

function StageChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'rounded-full px-3 py-1.5 text-sm font-medium ring-1',
        active ? 'bg-brand-800 text-white ring-brand-800' : 'bg-white text-stone-700 ring-stone-300 hover:bg-stone-100',
      )}
    >
      {label} <span className={cx('tabular-nums', active ? 'text-white/80' : 'text-stone-500')}>{count}</span>
    </button>
  )
}

function AddAccountModal({ open, onClose, defaultType }: { open: boolean; onClose: () => void; defaultType: AccountType }) {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ type: defaultType, name: '', full_name: '', role: '', email: '', phone: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!form.name.trim()) return setError('Zadajte názov.')
    if (form.email && !isValidEmail(form.email)) return setError('Neplatný e-mail.')
    setBusy(true)
    setError(null)
    const { data, error: e } = await supabase
      .from('accounts')
      .insert({ type: form.type, name: form.name.trim(), owner_id: profile!.user_id, created_by: profile!.user_id })
      .select('id')
      .single()
    if (e || !data) {
      setBusy(false)
      return setError(e?.code === '23505' ? 'Záznam s týmto názvom už existuje.' : dbError(e))
    }
    if (form.full_name || form.email || form.phone) {
      await supabase.from('account_contacts').insert({
        account_id: data.id,
        full_name: form.full_name.trim(),
        role: form.role.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim(),
      })
    }
    setBusy(false)
    onClose()
    navigate(`/kluby/${data.id}`)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pridať klub alebo partnera"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Zrušiť
          </Button>
          <Button variant="primary" busy={busy} onClick={save}>
            Pridať
          </Button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Typ" htmlFor="a-type">
          <Select id="a-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AccountType })}>
            <option value="club">Klub</option>
            <option value="partner">Partner / sponzor</option>
          </Select>
        </Field>
        <Field label="Názov" htmlFor="a-name">
          <Input id="a-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Kontaktná osoba (nepovinné)" htmlFor="a-person">
          <Input id="a-person" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label="Funkcia" htmlFor="a-role">
          <Input id="a-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
        </Field>
        <Field label="E-mail" htmlFor="a-email">
          <Input id="a-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Telefón" htmlFor="a-phone">
          <Input id="a-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
