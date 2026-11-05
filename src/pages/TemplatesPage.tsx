import { useState } from 'react'
import { Alert, Button, Card, Checkbox, Empty, Field, Input, Loading, PageHeader, Textarea } from '../components/ui'
import { useAuth } from '../lib/auth'
import { must, useLoad } from '../lib/data'
import { dbError, supabase } from '../lib/supabase'
import { formatLocal } from '../lib/time'
import type { Template } from '../lib/types'

const STARTERS = [
  {
    name: 'Prvé oslovenie klubu',
    subject: 'Spolupráca s {klub|vaším klubom}',
    body: 'Dobrý deň {meno|},\n\nvolám sa Jakub Kelemen a v Cader pomáhame futbalovým klubom ...\n\nBudem rád, ak si nájdete 15 minút na krátky hovor.\n\nS pozdravom\nJakub Kelemen\nCader',
  },
  {
    name: 'Follow-up',
    subject: 'Re: Spolupráca s {klub|vaším klubom}',
    body: 'Dobrý deň {meno|},\n\nnadväzujem na môj predchádzajúci e-mail ...\n\nS pozdravom\nJakub Kelemen\nCader',
  },
]

export function TemplatesPage() {
  const { profile } = useAuth()
  const list = useLoad(async () => (await must(supabase.from('templates').select('*').order('name'))) as Template[])
  const [edit, setEdit] = useState<Partial<Template> | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!edit?.name?.trim()) return
    setBusy(true)
    const payload = { name: edit.name.trim(), subject: edit.subject ?? '', body_text: edit.body_text ?? '', shared: edit.shared ?? true }
    const { error } = edit.id
      ? await supabase.from('templates').update(payload).eq('id', edit.id)
      : await supabase.from('templates').insert({ ...payload, owner_id: profile!.user_id })
    setBusy(false)
    if (error) return setMsg({ tone: 'error', text: dbError(error) })
    setMsg({ tone: 'success', text: 'Šablóna uložená.' })
    setEdit(null)
    list.reload()
  }

  async function remove(t: Template) {
    if (!confirm(`Odstrániť šablónu „${t.name}“?`)) return
    const { error } = await supabase.from('templates').delete().eq('id', t.id)
    if (error) setMsg({ tone: 'error', text: dbError(error) })
    list.reload()
  }

  const canEdit = (t: Template) => t.owner_id === profile?.user_id || profile?.role === 'admin'

  return (
    <>
      <PageHeader
        title="Šablóny"
        description="Opakovane použiteľné texty. Zdieľané šablóny vidí celý tím."
        actions={
          <Button variant="primary" onClick={() => setEdit({ name: '', subject: '', body_text: '', shared: true })}>
            Nová šablóna
          </Button>
        }
      />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {edit && (
          <Card title={edit.id ? 'Upraviť šablónu' : 'Nová šablóna'}>
            <div className="space-y-4">
              {!edit.id && (
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="text-stone-600">Začať z:</span>
                  {STARTERS.map((s) => (
                    <button key={s.name} type="button" className="underline" onClick={() => setEdit({ ...edit, name: s.name, subject: s.subject, body_text: s.body })}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              <Field label="Názov" htmlFor="t-name">
                <Input id="t-name" value={edit.name ?? ''} maxLength={200} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label="Predmet" htmlFor="t-subject">
                <Input id="t-subject" value={edit.subject ?? ''} maxLength={500} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
              </Field>
              <Field label="Text" htmlFor="t-body">
                <Textarea id="t-body" rows={10} value={edit.body_text ?? ''} onChange={(e) => setEdit({ ...edit, body_text: e.target.value })} />
              </Field>
              <Checkbox checked={edit.shared ?? true} onChange={(e) => setEdit({ ...edit, shared: e.target.checked })} label="Zdieľať s tímom" />
              <div className="flex gap-2">
                <Button variant="primary" busy={busy} onClick={save} disabled={!edit.name?.trim()}>
                  Uložiť
                </Button>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  Zrušiť
                </Button>
              </div>
            </div>
          </Card>
        )}
        {list.error && <Alert tone="error">{list.error}</Alert>}
        {list.loading && !list.data && <Loading />}
        {list.data?.length === 0 && <Empty title="Zatiaľ žiadne šablóny">Vytvorte napríklad „Prvé oslovenie klubu“ alebo „Follow-up“.</Empty>}
        <div className="grid gap-4 md:grid-cols-2">
          {list.data?.map((t) => (
            <Card
              key={t.id}
              title={t.name}
              actions={
                canEdit(t) && (
                  <>
                    <Button variant="ghost" onClick={() => setEdit(t)}>
                      Upraviť
                    </Button>
                    <Button variant="ghost" onClick={() => remove(t)}>
                      Odstrániť
                    </Button>
                  </>
                )
              }
            >
              <p className="text-sm font-medium">{t.subject || <span className="text-stone-400">(bez predmetu)</span>}</p>
              <pre className="mt-2 line-clamp-6 font-sans text-sm whitespace-pre-wrap text-stone-600">{t.body_text}</pre>
              <p className="mt-3 text-xs text-stone-500">
                {t.shared ? 'Zdieľaná' : 'Súkromná'} · upravené {formatLocal(t.updated_at)}
              </p>
            </Card>
          ))}
        </div>
      </div>
    </>
  )
}
