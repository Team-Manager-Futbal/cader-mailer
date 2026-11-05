import { useState } from 'react'
import { Alert, Button, Card, Field, Input, PageHeader } from '../components/ui'
import { useAuth } from '../lib/auth'
import { dbError, supabase } from '../lib/supabase'
import { PasswordForm } from './SetPasswordPage'

export function AccountPage() {
  const { profile, refreshProfile, signOut } = useAuth()
  const [name, setName] = useState(profile?.full_name ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  async function saveName() {
    setBusy(true)
    const { error } = await supabase.rpc('update_my_name', { p_full_name: name })
    setBusy(false)
    setMsg(error ? { tone: 'error', text: dbError(error) } : { tone: 'success', text: 'Meno bolo uložené.' })
    if (!error) refreshProfile()
  }

  return (
    <>
      <PageHeader title="Môj účet" description={profile?.email} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profil">
          <div className="space-y-4">
            {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
            <Field label="Meno a priezvisko" htmlFor="full-name">
              <Input id="full-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button variant="primary" busy={busy} onClick={saveName}>
              Uložiť
            </Button>
          </div>
        </Card>
        <Card title="Zmena hesla">
          <PasswordForm onDone={() => setMsg({ tone: 'success', text: 'Heslo bolo zmenené.' })} submitLabel="Zmeniť heslo" />
        </Card>
        <Card title="Relácia">
          <p className="mb-3 text-sm text-stone-600">Odhlási vás na tomto zariadení.</p>
          <Button onClick={signOut}>Odhlásiť sa</Button>
        </Card>
      </div>
    </>
  )
}
