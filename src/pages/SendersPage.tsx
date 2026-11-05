import { useState } from 'react'
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Loading, Modal, PageHeader, Select } from '../components/ui'
import { must, useLoad } from '../lib/data'
import { ApiError, callFunction, dbError, supabase } from '../lib/supabase'
import { formatLocal } from '../lib/time'
import type { SenderAccount } from '../lib/types'

type Form = Pick<SenderAccount, 'email' | 'display_name' | 'provider' | 'smtp_host' | 'smtp_port' | 'smtp_tls' | 'smtp_username' | 'reply_to' | 'rate_per_minute' | 'hourly_cap' | 'daily_cap'> & { id?: string }

const EMPTY: Form = {
  email: 'jakub.kelemen@caderapp.com',
  display_name: 'Jakub Kelemen – Cader',
  provider: 'seznam',
  smtp_host: 'smtp.seznam.cz',
  smtp_port: 465,
  smtp_tls: true,
  smtp_username: '',
  reply_to: '',
  rate_per_minute: 2,
  hourly_cap: 60,
  daily_cap: 200,
}

export function SendersPage() {
  const list = useLoad(async () => (await must(supabase.from('sender_accounts').select('*').order('email'))) as SenderAccount[])
  const [form, setForm] = useState<Form | null>(null)
  const [pwFor, setPwFor] = useState<SenderAccount | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  async function save() {
    if (!form) return
    setBusy('save')
    const { id, ...rest } = form
    const payload = { ...rest, reply_to: rest.reply_to?.trim() || null, smtp_username: rest.smtp_username.trim() || rest.email.trim(), email: rest.email.trim().toLowerCase() }
    const { error } = id ? await supabase.from('sender_accounts').update(payload).eq('id', id) : await supabase.from('sender_accounts').insert(payload)
    setBusy(null)
    if (error) return setMsg({ tone: 'error', text: error.code === '23514' ? 'Skontrolujte formát adries a limity.' : dbError(error) })
    setMsg({ tone: 'success', text: 'Odosielateľ uložený. Nastavte heslo a otestujte pripojenie.' })
    setForm(null)
    list.reload()
  }

  async function fn(action: 'set_password' | 'clear_password' | 'test', s: SenderAccount, extra: Record<string, unknown> = {}) {
    setBusy(`${action}:${s.id}`)
    setMsg(null)
    try {
      const r = await callFunction<{ ok: boolean; message?: string }>('sender-admin', { action, sender_id: s.id, ...extra })
      setMsg({ tone: r.ok ? 'success' : 'error', text: r.message ?? (r.ok ? 'Hotovo.' : 'Zlyhalo.') })
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof ApiError ? e.message : 'Akcia zlyhala.' })
    } finally {
      setBusy(null)
      list.reload()
    }
  }

  async function setActive(s: SenderAccount, active: boolean) {
    const { error } = await supabase.from('sender_accounts').update({ active }).eq('id', s.id)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    list.reload()
  }

  async function unblock(s: SenderAccount) {
    if (!confirm('Odblokovať odosielateľa? Urobte to až po overení, že poskytovateľ odosielanie opäť povoľuje (napr. po kontakte s podporou Seznamu). Pozastavené kampane treba potom ručne obnoviť.')) return
    const { error } = await supabase.rpc('sender_unblock', { p_sender: s.id })
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    list.reload()
  }

  async function remove(s: SenderAccount) {
    if (!confirm(`Odstrániť odosielateľa ${s.email}? Nejde to, ak ho používa niektorá kampaň.`)) return
    const { error } = await supabase.from('sender_accounts').delete().eq('id', s.id)
    if (error) setMsg({ tone: 'error', text: error.code === '23503' ? 'Odosielateľa používajú kampane. Namiesto odstránenia ho deaktivujte.' : dbError(error) })
    list.reload()
  }

  return (
    <>
      <PageHeader
        title="Odosielatelia"
        description="Schránky, z ktorých sa odosiela. Heslá sa ukladajú šifrovane na serveri a už sa nikdy nezobrazia."
        actions={
          <Button variant="primary" onClick={() => setForm(EMPTY)}>
            Pridať odosielateľa
          </Button>
        }
      />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Alert tone="info">
          Seznam nezverejňuje presné limity odosielania a neodporúča hromadné rozosielky z bežných schránok. Začnite opatrne (predvolene 2 správy/min, 60/h, 200/deň) a pri odmietnutí
          sa odosielanie automaticky zastaví.
        </Alert>

        {form && (
          <Card title={form.id ? 'Upraviť odosielateľa' : 'Nový odosielateľ'}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="E-mailová adresa odosielateľa" htmlFor="s-email">
                <Input id="s-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="Zobrazované meno" htmlFor="s-name">
                <Input id="s-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
              </Field>
              <Field label="Poskytovateľ" htmlFor="s-provider">
                <Select
                  id="s-provider"
                  value={form.provider}
                  onChange={(e) => {
                    const provider = e.target.value as 'seznam' | 'custom'
                    setForm({ ...form, provider, ...(provider === 'seznam' ? { smtp_host: 'smtp.seznam.cz', smtp_port: 465, smtp_tls: true } : {}) })
                  }}
                >
                  <option value="seznam">Seznam.cz / Email Profi</option>
                  <option value="custom">Vlastný SMTP server</option>
                </Select>
              </Field>
              <Field label="Reply-To (nepovinné)" htmlFor="s-reply" hint="Adresa pre odpovede. Musí byť vaša overená adresa.">
                <Input id="s-reply" type="email" value={form.reply_to ?? ''} onChange={(e) => setForm({ ...form, reply_to: e.target.value })} />
              </Field>
              <Field label="SMTP server" htmlFor="s-host">
                <Input id="s-host" value={form.smtp_host} disabled={form.provider === 'seznam'} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} />
              </Field>
              <Field label="Port" htmlFor="s-port" hint="Podporované je len SSL/TLS (implicitné), typicky 465.">
                <Input id="s-port" type="number" value={form.smtp_port} disabled={form.provider === 'seznam'} onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })} />
              </Field>
              <Field label="SMTP používateľ" htmlFor="s-user" hint="Pri Sezname celá e-mailová adresa. Prázdne = adresa odosielateľa.">
                <Input id="s-user" value={form.smtp_username} onChange={(e) => setForm({ ...form, smtp_username: e.target.value })} />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Za minútu" htmlFor="s-rate">
                  <Input id="s-rate" type="number" min={1} max={60} value={form.rate_per_minute} onChange={(e) => setForm({ ...form, rate_per_minute: Number(e.target.value) })} />
                </Field>
                <Field label="Za hodinu" htmlFor="s-hour">
                  <Input id="s-hour" type="number" min={1} value={form.hourly_cap} onChange={(e) => setForm({ ...form, hourly_cap: Number(e.target.value) })} />
                </Field>
                <Field label="Za 24 h" htmlFor="s-day">
                  <Input id="s-day" type="number" min={1} value={form.daily_cap} onChange={(e) => setForm({ ...form, daily_cap: Number(e.target.value) })} />
                </Field>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" busy={busy === 'save'} onClick={save}>
                Uložiť
              </Button>
              <Button variant="ghost" onClick={() => setForm(null)}>
                Zrušiť
              </Button>
            </div>
          </Card>
        )}

        {list.error && <Alert tone="error">{list.error}</Alert>}
        {list.loading && !list.data && <Loading />}
        {list.data?.length === 0 && !form && <Alert tone="warning">Zatiaľ nie je pridaný žiadny odosielateľ.</Alert>}
        {list.data?.map((s) => {
          const blocked = s.blocked_until && new Date(s.blocked_until) > new Date()
          return (
            <Card
              key={s.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {s.display_name ? `${s.display_name} <${s.email}>` : s.email}
                  {s.active ? <Badge tone="green">Aktívny</Badge> : <Badge>Neaktívny</Badge>}
                  {blocked && <Badge tone="red">Zablokovaný</Badge>}
                </span>
              }
              actions={
                <>
                  <Button variant="ghost" onClick={() => setForm({ ...s, reply_to: s.reply_to ?? '' })}>
                    Upraviť
                  </Button>
                  <Button variant="ghost" onClick={() => remove(s)}>
                    Odstrániť
                  </Button>
                </>
              }
            >
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-xs text-stone-500">SMTP</dt>
                  <dd className="font-medium">
                    {s.smtp_host}:{s.smtp_port} {s.smtp_tls ? 'SSL/TLS' : '(bez TLS – nepodporované)'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">Používateľ</dt>
                  <dd className="font-medium break-all">{s.smtp_username || s.email}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">Heslo</dt>
                  <dd className="font-medium">{s.credential_set ? 'Uložené (šifrované)' : 'Nenastavené'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">Limity</dt>
                  <dd className="font-medium">
                    {s.rate_per_minute}/min · {s.hourly_cap}/h · {s.daily_cap}/24 h
                  </dd>
                </div>
              </dl>
              <div className="mt-4">
                {s.last_test_ok === true && <Alert tone="success">Posledný test {formatLocal(s.last_test_at)}: {s.last_test_message}</Alert>}
                {s.last_test_ok === false && <Alert tone="error">Posledný test {formatLocal(s.last_test_at)}: {s.last_test_message}</Alert>}
                {s.last_test_ok === null && <Alert tone="warning">{s.last_test_message ?? 'Pripojenie ešte nebolo otestované.'}</Alert>}
                {blocked && (
                  <div className="mt-3">
                    <Alert tone="error" title="Odosielanie zastavené">
                      {s.blocked_reason}
                    </Alert>
                  </div>
                )}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => { setPwFor(s); setPassword('') }}>{s.credential_set ? 'Zmeniť heslo' : 'Nastaviť heslo'}</Button>
                <Button onClick={() => fn('test', s)} busy={busy === `test:${s.id}`} disabled={!s.credential_set}>
                  Otestovať pripojenie
                </Button>
                {s.credential_set && (
                  <Button variant="ghost" onClick={() => confirm('Odstrániť uložené heslo? Odosielateľ sa deaktivuje.') && fn('clear_password', s)}>
                    Odstrániť heslo
                  </Button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {blocked && (
                    <Button variant="danger" onClick={() => unblock(s)}>
                      Odblokovať
                    </Button>
                  )}
                  <Checkbox
                    checked={s.active}
                    disabled={!s.active && s.last_test_ok !== true}
                    onChange={(e) => setActive(s, e.target.checked)}
                    label={s.last_test_ok === true || s.active ? 'Aktívny (povoliť odosielanie)' : 'Aktivovať až po úspešnom teste'}
                  />
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      <Modal
        open={Boolean(pwFor)}
        onClose={() => setPwFor(null)}
        title={`Heslo pre ${pwFor?.email ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPwFor(null)}>
              Zrušiť
            </Button>
            <Button
              variant="primary"
              busy={busy === `set_password:${pwFor?.id}`}
              disabled={!password}
              onClick={async () => {
                const s = pwFor!
                setPwFor(null)
                await fn('set_password', s, { password })
                setPassword('')
              }}
            >
              Uložiť šifrovane
            </Button>
          </>
        }
      >
        <p>Heslo sa odošle priamo na server, zašifruje (AES-256-GCM) a už sa nikde nezobrazí. Pri zapnutom dvojfaktorovom overení na Sezname použite aplikačné heslo.</p>
        <Field label="SMTP heslo" htmlFor="smtp-pw">
          <Input id="smtp-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </Modal>
    </>
  )
}
