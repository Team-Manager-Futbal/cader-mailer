import { type FormEvent, useState } from 'react'
import { Alert, Button, Field, Input } from '../components/ui'
import { supabase } from '../lib/supabase'

function siteUrl() {
  return `${window.location.origin}${window.location.pathname}`
}

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'reset'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (error) {
        setError(
          /invalid login/i.test(error.message)
            ? 'Nesprávny e-mail alebo heslo.'
            : /banned|disabled/i.test(error.message)
              ? 'Účet je deaktivovaný.'
              : /rate|too many/i.test(error.message)
                ? 'Príliš veľa pokusov. Skúste to o chvíľu.'
                : 'Prihlásenie zlyhalo. Skúste to znova.',
        )
      }
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: siteUrl() })
      // Same message either way: do not reveal whether the account exists.
      if (error && /rate|too many/i.test(error.message)) setError('Príliš veľa žiadostí. Skúste to neskôr.')
      else setInfo('Ak účet s touto adresou existuje, poslali sme naň odkaz na nastavenie nového hesla.')
    }
    setBusy(false)
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-lg bg-brand-800 text-white" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="M3 7l9 6 9-6M3 7v11h18V7" />
            </svg>
          </span>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Cader Mailer</h1>
          <p className="mt-1 text-sm text-stone-600">Interný nástroj tímu Cader. Prístup len na pozvánku.</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-lg bg-white p-6 ring-1 ring-stone-200" noValidate>
          <h2 className="text-lg font-semibold">{mode === 'login' ? 'Prihlásenie' : 'Zabudnuté heslo'}</h2>
          {error && <Alert tone="error">{error}</Alert>}
          {info && <Alert tone="success">{info}</Alert>}
          <Field label="E-mail" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {mode === 'login' && (
            <Field label="Heslo" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          <Button type="submit" variant="primary" busy={busy} className="w-full" disabled={!email || (mode === 'login' && !password)}>
            {mode === 'login' ? 'Prihlásiť sa' : 'Poslať odkaz'}
          </Button>
          <button
            type="button"
            className="w-full text-center text-sm text-stone-600 underline-offset-2 hover:underline"
            onClick={() => {
              setMode(mode === 'login' ? 'reset' : 'login')
              setError(null)
              setInfo(null)
            }}
          >
            {mode === 'login' ? 'Zabudli ste heslo?' : 'Späť na prihlásenie'}
          </button>
        </form>
      </div>
    </div>
  )
}
