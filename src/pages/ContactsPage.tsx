import { useState } from 'react'
import { Alert, Button, Card, Field, Input, Loading, PageHeader, Select, TableWrap, Td, Th } from '../components/ui'
import { useIsAdmin } from '../lib/auth'
import { must, useLoad } from '../lib/data'
import { isValidEmail, normalizeEmail } from '../lib/emails'
import { dbError, supabase } from '../lib/supabase'
import { formatLocal } from '../lib/time'
import { RECIPIENT_LABELS, type Recipient } from '../lib/types'

interface Suppression {
  email_normalized: string
  reason: string
  note: string | null
  created_at: string
}

const REASONS: Record<string, string> = {
  unsubscribe: 'Odhlásenie cez odkaz',
  manual: 'Ručne pridané',
  objection: 'Námietka / výmaz',
  bounce: 'Nedoručiteľné',
}

export function ContactsPage() {
  const isAdmin = useIsAdmin()
  const list = useLoad(async () => (await must(supabase.from('suppression_list').select('*').order('created_at', { ascending: false }).limit(2000))) as Suppression[])
  const [email, setEmail] = useState('')
  const [reason, setReason] = useState<'manual' | 'objection'>('manual')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<(Recipient & { campaigns: { name: string } | null })[] | null>(null)

  async function add() {
    const n = normalizeEmail(email)
    if (!isValidEmail(n)) return setMsg({ tone: 'error', text: 'Neplatná e-mailová adresa.' })
    const { data: me } = await supabase.auth.getUser()
    const { error } = await supabase.from('suppression_list').insert({ email_normalized: n, reason, note: note || null, created_by: me.user?.id })
    if (error) return setMsg({ tone: 'error', text: error.code === '23505' ? 'Adresa už je na zozname odhlásených.' : dbError(error) })
    setMsg({ tone: 'success', text: `${n} už nedostane žiadnu ďalšiu správu z Cader Mailer.` })
    setEmail('')
    setNote('')
    list.reload()
  }

  async function remove(s: Suppression) {
    if (!confirm(`Odstrániť ${s.email_normalized} zo zoznamu odhlásených? Robte to len s preukázateľným súhlasom osoby.`)) return
    const { error } = await supabase.from('suppression_list').delete().eq('email_normalized', s.email_normalized)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    list.reload()
  }

  async function search() {
    const n = normalizeEmail(q)
    if (!n) return
    const { data, error } = await supabase
      .from('campaign_recipients')
      .select('*, campaigns(name)')
      .ilike('email_normalized', `%${n.replace(/[%_]/g, '')}%`)
      .limit(200)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    setFound((data ?? []) as never)
  }

  async function erase(addr: string) {
    if (!confirm(`Natrvalo vymazať všetky záznamy o ${addr} zo všetkých kampaní? Adresa zostane na zozname odhlásených, aby sme ju znova neoslovili.`)) return
    const { data, error } = await supabase.rpc('admin_erase_contact', { p_email: addr })
    if (error) return setMsg({ tone: 'error', text: dbError(error) })
    setMsg({ tone: 'success', text: `Vymazaných záznamov: ${data}.` })
    setFound(null)
    list.reload()
  }

  return (
    <>
      <PageHeader title="Kontakty" description="Zoznam odhlásených platí pre celý tím a pre všetky kampane. Kontroluje sa pri importe aj tesne pred každým odoslaním." />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Card title="Pridať na zoznam odhlásených">
          <div className="grid items-end gap-4 md:grid-cols-[1fr_14rem_1fr_auto]">
            <Field label="E-mail" htmlFor="sup-email">
              <Input id="sup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Dôvod" htmlFor="sup-reason">
              <Select id="sup-reason" value={reason} onChange={(e) => setReason(e.target.value as 'manual' | 'objection')}>
                <option value="manual">Ručne (žiadosť e-mailom, telefonicky…)</option>
                <option value="objection">Námietka</option>
              </Select>
            </Field>
            <Field label="Poznámka" htmlFor="sup-note">
              <Input id="sup-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Button variant="primary" onClick={add} disabled={!email}>
              Pridať
            </Button>
          </div>
        </Card>

        <Card title="Vyhľadať kontakt v kampaniach">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full max-w-sm">
              <Field label="E-mail alebo jeho časť" htmlFor="q">
                <Input id="q" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
              </Field>
            </div>
            <Button onClick={search}>Hľadať</Button>
          </div>
          {found && (
            <div className="mt-4">
              {found.length === 0 ? (
                <p className="text-sm text-stone-600">Nič sa nenašlo (vidíte len svoje kampane, admin vidí všetky).</p>
              ) : (
                <TableWrap>
                  <thead>
                    <tr>
                      <Th>E-mail</Th>
                      <Th>Kampaň</Th>
                      <Th>Stav</Th>
                      <Th>Klub</Th>
                      {isAdmin && <Th />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {found.map((r) => (
                      <tr key={r.id}>
                        <Td>{r.email}</Td>
                        <Td>{r.campaigns?.name ?? '–'}</Td>
                        <Td>{RECIPIENT_LABELS[r.state]}</Td>
                        <Td>{r.klub || '–'}</Td>
                        {isAdmin && (
                          <Td>
                            <button type="button" className="text-xs text-red-700 underline" onClick={() => erase(r.email_normalized)}>
                              Vymazať údaje (GDPR)
                            </button>
                          </Td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </div>
          )}
        </Card>

        <Card title={`Odhlásení${list.data ? ` (${list.data.length})` : ''}`}>
          {list.error && <Alert tone="error">{list.error}</Alert>}
          {list.loading && !list.data && <Loading />}
          {list.data && list.data.length === 0 && <p className="text-sm text-stone-600">Zatiaľ sa nikto neodhlásil.</p>}
          {list.data && list.data.length > 0 && (
            <TableWrap>
              <thead>
                <tr>
                  <Th>E-mail</Th>
                  <Th>Dôvod</Th>
                  <Th>Poznámka</Th>
                  <Th>Kedy</Th>
                  {isAdmin && <Th />}
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {list.data.map((s) => (
                  <tr key={s.email_normalized}>
                    <Td>{s.email_normalized}</Td>
                    <Td>{REASONS[s.reason] ?? s.reason}</Td>
                    <Td>{s.note || '–'}</Td>
                    <Td className="whitespace-nowrap">{formatLocal(s.created_at)}</Td>
                    {isAdmin && (
                      <Td>
                        <button type="button" className="text-xs text-stone-600 underline" onClick={() => remove(s)}>
                          Odstrániť
                        </button>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  )
}
