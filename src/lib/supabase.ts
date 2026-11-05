import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const configured = Boolean(url && key)

// Publishable key only. All data access is protected by RLS on the server.
export const supabase = createClient(url || 'https://not-configured.invalid', key || 'not-configured', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
})

export const functionsUrl = `${url ?? ''}/functions/v1`

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

/** Calls an authenticated Edge Function and returns its JSON (throws ApiError with a Slovak message). */
export async function callFunction<T = unknown>(name: string, body: unknown): Promise<T> {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  if (!token) throw new ApiError('Nie ste prihlásený.', 'unauthenticated')
  let res: Response
  try {
    res = await fetch(`${functionsUrl}/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: key ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Server je nedostupný. Skontrolujte pripojenie.', 'network')
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!res.ok && !(json && typeof json === 'object' && 'ok' in json)) {
    throw new ApiError(json?.message || errorMessage(json?.error) || `Chyba servera (${res.status}).`, json?.error)
  }
  return json
}

const MESSAGES: Record<string, string> = {
  not_authorized: 'Na túto akciu nemáte oprávnenie.',
  campaign_not_draft: 'Kampaň už nie je koncept, nedá sa upravovať.',
  acknowledgement_required: 'Potvrďte kontrolu právneho základu a podmienok.',
  legal_basis_required: 'Vyberte právny základ oslovenia.',
  legal_note_required: 'Pri „inom právnom základe“ doplňte poznámku (min. 10 znakov).',
  sender_not_permitted: 'Tohto odosielateľa nemáte pridelený.',
  sender_not_ready: 'Odosielateľ nie je pripravený (aktívny, heslo uložené a úspešný test pripojenia).',
  content_missing: 'Vyplňte predmet aj text správy.',
  schedule_in_past: 'Čas začiatku musí byť v budúcnosti.',
  schedule_too_far: 'Čas začiatku je príliš ďaleko v budúcnosti.',
  rate_not_allowed: 'Zvolená rýchlosť odosielania nie je povolená.',
  no_recipients: 'Kampaň nemá žiadneho príjemcu, ktorému možno poslať správu.',
  invalid_transition: 'Táto zmena stavu teraz nie je možná.',
  campaign_too_large: 'Kampaň môže mať najviac 2000 príjemcov.',
  too_many_rows: 'Naraz možno importovať najviac 5000 riadkov.',
  cannot_demote_self: 'Nemôžete odobrať rolu admin ani deaktivovať sami seba.',
  last_admin: 'Musí zostať aspoň jeden aktívny admin.',
  contact_in_flight: 'Kontaktu sa práve odosiela správa, skúste o chvíľu.',
  campaign_not_active: 'Kampaň nie je aktívna.',
}

export function errorMessage(code?: string | null): string | undefined {
  if (!code) return undefined
  const key = Object.keys(MESSAGES).find((k) => code.includes(k))
  return key ? MESSAGES[key] : undefined
}

/** Converts a PostgREST/RPC error to a user-friendly Slovak message. */
export function dbError(e: { message?: string; code?: string } | null | undefined): string {
  if (!e) return 'Neznáma chyba.'
  const known = errorMessage(e.message)
  if (known) return known
  if (e.code === '42501' || /row-level security|permission denied/.test(e.message ?? '')) return MESSAGES.not_authorized
  if (e.code === '23505') return 'Záznam už existuje.'
  return 'Operácia zlyhala. Skúste to znova.'
}
