import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Alert, Button } from '../components/ui'
import { functionsUrl } from '../lib/supabase'

// Public page linked from every campaign e-mail. The unsubscribe happens only after the
// recipient clicks the button (POST), so link scanners/previews cannot trigger it.
export function UnsubscribePage() {
  const [params] = useSearchParams()
  const token = params.get('t') ?? ''
  const valid = /^[0-9a-f]{64}$/.test(token)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')

  async function confirm() {
    setState('busy')
    try {
      const res = await fetch(`${functionsUrl}/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      setState(res.ok ? 'done' : 'error')
    } catch {
      setState('error')
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 ring-1 ring-stone-200">
        <h1 className="text-xl font-semibold">Odhlásenie z ďalších správ</h1>
        {!valid && <Alert tone="error">Odkaz na odhlásenie je neúplný. Skopírujte prosím celý odkaz z e-mailu, alebo odpovedzte na e-mail so žiadosťou o odhlásenie.</Alert>}
        {valid && state !== 'done' && (
          <>
            <p className="text-sm text-stone-700">
              Potvrďte, že si neželáte dostávať ďalšie správy od tímu Cader (caderapp.com). Odhlásenie je bezplatné a platí pre všetky naše ďalšie oslovenia.
            </p>
            {state === 'error' && <Alert tone="error">Odhlásenie sa nepodarilo. Skúste to znova alebo odpovedzte na e-mail so žiadosťou o odhlásenie.</Alert>}
            <Button variant="primary" busy={state === 'busy'} onClick={confirm}>
              Odhlásiť sa
            </Button>
          </>
        )}
        {state === 'done' && <Alert tone="success" title="Hotovo">Vaša adresa bola zaradená na zoznam odhlásených. Ďalšie správy od nás už nedostanete.</Alert>}
      </div>
    </div>
  )
}
