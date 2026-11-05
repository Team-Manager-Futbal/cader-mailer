// Placeholder rendering shared by the frontend preview and the Edge Functions.
// Pure TypeScript, no runtime-specific APIs. Output is always plain text (never HTML).

export const FIELDS = ['meno', 'klub', 'pozicia'] as const
export type Field = (typeof FIELDS)[number]
export type MergeData = Partial<Record<Field, string | null | undefined>>

/** `{meno}` or `{meno|fallback text}` */
const PLACEHOLDER = /\{([a-zA-Z_]+)(?:\|([^{}]*))?\}/g

export interface RenderResult {
  text: string
  /** Placeholders without a value and without a fallback. Sending must be refused. */
  missing: Field[]
  /** Unknown placeholder names, e.g. a typo like {mneo}. */
  unknown: string[]
}

export function render(template: string, data: MergeData, extra: Record<string, string> = {}): RenderResult {
  const missing = new Set<Field>()
  const unknown = new Set<string>()
  const text = template.replace(PLACEHOLDER, (whole, rawName: string, fallback: string | undefined) => {
    const name = rawName.toLowerCase()
    if (name in extra) return extra[name]
    if (!(FIELDS as readonly string[]).includes(name)) {
      unknown.add(rawName)
      return whole
    }
    const value = (data[name as Field] ?? '').toString().trim()
    if (value) return value
    if (fallback !== undefined) return fallback.trim()
    missing.add(name as Field)
    return ''
  })
  return { text, missing: [...missing], unknown: [...unknown] }
}

/** Placeholders the template uses (lowercased, unique). */
export function usedFields(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(PLACEHOLDER)) out.add(m[1].toLowerCase())
  return [...out]
}

export interface ComposeInput {
  subject: string
  body: string
  footer: string
  unsubscribeUrl: string
  data: MergeData
}

export interface ComposedMessage {
  subject: string
  body: string
  missing: Field[]
  unknown: string[]
}

/** Full message as the recipient will see it: body + identification/opt-out footer. */
export function composeMessage({ subject, body, footer, unsubscribeUrl, data }: ComposeInput): ComposedMessage {
  const s = render(subject, data)
  const b = render(body, data)
  const f = render(footer, data, { odhlasenie: unsubscribeUrl })
  let footerText = f.text.trim()
  // The opt-out link must always be present, even if an admin removed {odhlasenie} from the footer.
  if (!footerText.includes(unsubscribeUrl)) {
    footerText = `${footerText}\n\nOdhlásenie z ďalších správ: ${unsubscribeUrl}`.trim()
  }
  const unique = <T,>(xs: T[]) => [...new Set(xs)]
  return {
    // Subjects are single-line.
    subject: s.text.replace(/[\r\n]+/g, ' ').trim(),
    body: `${b.text.replace(/\s+$/, '')}\n\n${footerText}\n`,
    missing: unique([...s.missing, ...b.missing, ...f.missing]),
    unknown: unique([...s.unknown, ...b.unknown, ...f.unknown]),
  }
}

export function unsubscribeUrl(frontendUrl: string, token: string): string {
  const base = frontendUrl.replace(/#.*$/, '').replace(/\/?$/, '/')
  return `${base}#/odhlasenie?t=${token}`
}
