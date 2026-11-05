import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Field, Input } from '../components/ui'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

export function PasswordForm({ onDone, submitLabel = 'Uložiť heslo' }: { onDone: () => void; submitLabel?: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tooShort = password.length > 0 && password.length < 10
  const mismatch = confirm.length > 0 && confirm !== password

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 10 || password !== confirm) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) {
      setError(/same/i.test(error.message) ? 'Nové heslo musí byť iné ako predchádzajúce.' : /weak|pwned/i.test(error.message) ? 'Heslo je príliš slabé.' : 'Heslo sa nepodarilo uložiť.')
      return
    }
    setPassword('')
    setConfirm('')
    onDone()
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Nové heslo" htmlFor="new-password" hint="Aspoň 10 znakov." error={tooShort ? 'Heslo musí mať aspoň 10 znakov.' : null}>
        <Input id="new-password" type="password" autoComplete="new-password" value={password} aria-invalid={tooShort || undefined} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Zopakujte heslo" htmlFor="confirm-password" error={mismatch ? 'Heslá sa nezhodujú.' : null}>
        <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} aria-invalid={mismatch || undefined} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={password.length < 10 || password !== confirm}>
        {submitLabel}
      </Button>
    </form>
  )
}

export function SetPasswordPage() {
  const { clearNeedsPassword, refreshProfile } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 ring-1 ring-stone-200">
        <h1 className="text-lg font-semibold">Nastavte si heslo</h1>
        <p className="text-sm text-stone-600">Pre dokončenie pozvánky alebo obnovy prístupu si zvoľte nové heslo.</p>
        <PasswordForm
          onDone={async () => {
            clearNeedsPassword()
            await refreshProfile()
            navigate('/', { replace: true })
          }}
        />
      </div>
    </div>
  )
}
