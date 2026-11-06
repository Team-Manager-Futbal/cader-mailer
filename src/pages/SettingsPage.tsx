import { useEffect, useState } from 'react'
import { Alert, Button, Card, Field, Input, Loading, PageHeader, TableWrap, Td, Textarea, Th } from '../components/ui'
import { loadSettings, must, useLoad } from '../lib/data'
import { isValidEmail } from '../lib/emails'
import { dbError, supabase } from '../lib/supabase'
import { formatLocal } from '../lib/time'
import type { AppSettings } from '../lib/types'

interface AuditRow {
  id: number
  actor_id: string | null
  action: string
  entity: string | null
  entity_id: string | null
  details: Record<string, unknown>
  created_at: string
}

export function SettingsPage() {
  const settings = useLoad(loadSettings)
  const audit = useLoad(async () => (await must(supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200))) as AuditRow[])
  const profiles = useLoad(async () => new Map(((await must(supabase.from('profiles').select('user_id, email'))) as { user_id: string; email: string }[]).map((p) => [p.user_id, p.email])))
  const [form, setForm] = useState<AppSettings | null>(null)
  const [allow, setAllow] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (settings.data) {
      setForm(settings.data)
      setAllow(settings.data.test_recipient_allowlist.join('\n'))
    }
  }, [settings.data])

  const suggestedUrl = `${window.location.origin}${window.location.pathname}`

  async function save(patch?: Partial<AppSettings>) {
    if (!form) return
    const next = { ...form, ...patch }
    const list = allow.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (list.some((e) => !isValidEmail(e))) return setMsg({ tone: 'error', text: 'Zoznam testovacích adries obsahuje neplatnú adresu.' })
    if (next.frontend_url && !/^https:\/\/[^\s]+$/.test(next.frontend_url)) return setMsg({ tone: 'error', text: 'Adresa aplikácie musí začínať https://' })
    if (next.sending_enabled && !next.frontend_url) return setMsg({ tone: 'error', text: 'Pred zapnutím odosielania nastavte verejnú adresu aplikácie (odkaz na odhlásenie).' })
    setBusy(true)
    const { error } = await supabase
      .from('app_settings')
      .update({
        sending_enabled: next.sending_enabled,
        max_member_rate_per_minute: next.max_member_rate_per_minute,
        frontend_url: next.frontend_url.trim(),
        footer_text: next.footer_text,
        test_recipient_allowlist: list,
      })
      .eq('id', 1)
    setBusy(false)
    setMsg(error ? { tone: 'error', text: dbError(error) } : { tone: 'success', text: 'Nastavenia uložené.' })
    settings.reload()
    audit.reload()
  }

  if (!form) return settings.error ? <Alert tone="error">{settings.error}</Alert> : <Loading />

  return (
    <>
      <PageHeader title="Nastavenia" />
      <div className="space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Card title="Globálne odosielanie">
          <div className="space-y-3">
            {form.sending_enabled ? (
              <Alert tone="success" title="Odosielanie je ZAPNUTÉ">
                Naplánované a bežiace kampane sa spracúvajú. Vypnutím okamžite zastavíte všetky ďalšie správy (núdzová brzda).
              </Alert>
            ) : (
              <Alert tone="warning" title="Odosielanie je VYPNUTÉ">
                Žiadna kampaň nič neodošle. Zapnite až po overení SMTP, cron úlohy a testovacej správy (pozri docs/SETUP_CHECKLIST.md).
              </Alert>
            )}
            <Button
              variant={form.sending_enabled ? 'danger' : 'primary'}
              busy={busy}
              onClick={() => {
                const on = !form.sending_enabled
                if (on && !confirm('Zapnúť odosielanie pre celý tím?')) return
                save({ sending_enabled: on })
              }}
            >
              {form.sending_enabled ? 'Vypnúť všetko odosielanie' : 'Zapnúť odosielanie'}
            </Button>
          </div>
        </Card>

        <Card title="Všeobecné">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Verejná adresa aplikácie" htmlFor="url" hint={`Použije sa v odkaze na odhlásenie. Aktuálne: ${suggestedUrl}`}>
              <div className="flex gap-2">
                <Input id="url" value={form.frontend_url} onChange={(e) => setForm({ ...form, frontend_url: e.target.value })} placeholder="https://<user>.github.io/cader-mailer/" />
                <Button onClick={() => setForm({ ...form, frontend_url: suggestedUrl })}>Použiť aktuálnu</Button>
              </div>
            </Field>
            <Field label="Max. rýchlosť pre členov (správ/min)" htmlFor="maxrate" hint="Admin môže ísť do limitu odosielateľa.">
              <Input id="maxrate" type="number" min={1} max={30} value={form.max_member_rate_per_minute} onChange={(e) => setForm({ ...form, max_member_rate_per_minute: Number(e.target.value) })} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Pätička každej správy" htmlFor="footer" hint="Podpis pridaný na koniec každej správy (meno, firma, kontakt). Voliteľne {odhlasenie} vloží viditeľný odkaz na odhlásenie. Neviditeľná hlavička List-Unsubscribe sa pridáva vždy.">
                <Textarea id="footer" rows={4} value={form.footer_text} onChange={(e) => setForm({ ...form, footer_text: e.target.value })} />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Povolené adresy pre testovacie e-maily" htmlFor="allow" hint="Okrem vlastnej prihlasovacej adresy. Jedna na riadok.">
                <Textarea id="allow" rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} />
              </Field>
            </div>
          </div>
          <div className="mt-4">
            <Button variant="primary" busy={busy} onClick={() => save()}>
              Uložiť
            </Button>
          </div>
        </Card>

        <Card title="Audit log (posledných 200)" actions={<Button onClick={() => audit.reload()}>Obnoviť</Button>}>
          {audit.data && (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Čas</Th>
                  <Th>Kto</Th>
                  <Th>Akcia</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {audit.data.map((a) => (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap">{formatLocal(a.created_at)}</Td>
                    <Td>{a.actor_id ? profiles.data?.get(a.actor_id) ?? a.actor_id.slice(0, 8) : 'systém'}</Td>
                    <Td className="font-mono text-xs">{a.action}</Td>
                    <Td className="font-mono text-xs break-all text-stone-600">{JSON.stringify(a.details)}</Td>
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
