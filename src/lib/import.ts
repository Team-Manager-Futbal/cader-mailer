// Contact import: paste, CSV and XLSX. Everything stays in the browser until the user saves
// the campaign; the database revalidates every row again (campaign_set_recipients).
import Papa from 'papaparse'
import { isValidEmail, normalizeEmail } from './emails'

export type TargetField = 'email' | 'meno' | 'klub' | 'pozicia'
export const TARGET_FIELDS: TargetField[] = ['email', 'meno', 'klub', 'pozicia']
export const FIELD_LABELS: Record<TargetField, string> = {
  email: 'E-mail',
  meno: 'Meno',
  klub: 'Klub',
  pozicia: 'Pozícia',
}

export interface ContactRow {
  email: string
  meno: string
  klub: string
  pozicia: string
}

export interface Table {
  headers: string[]
  rows: string[][]
}

/** Lowercase, strip diacritics, unify separators: "E-mailová adresa" -> "e-mailova adresa". */
export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim()
}

const ALIASES: Record<TargetField, string[]> = {
  email: ['email', 'e-mail', 'e mail', 'mail', 'emailova adresa', 'e-mailova adresa', 'email address', 'e-mail address', 'adresa', 'kontakt'],
  meno: ['meno', 'name', 'meno a priezvisko', 'cele meno', 'kontaktna osoba', 'osoba', 'full name', 'first name', 'krstne meno', 'oslovenie'],
  klub: ['klub', 'club', 'nazov klubu', 'nazov', 'organizacia', 'organization', 'tim', 'team', 'oddiel', 'spolok', 'firma', 'company'],
  pozicia: ['pozicia', 'funkcia', 'position', 'role', 'rola', 'titul', 'title', 'job title'],
}

/** Best-effort automatic column mapping. Returns column index per field (or -1). */
export function guessMapping(headers: string[]): Record<TargetField, number> {
  const norm = headers.map(normalizeHeader)
  const used = new Set<number>()
  const out = { email: -1, meno: -1, klub: -1, pozicia: -1 } as Record<TargetField, number>
  for (const field of TARGET_FIELDS) {
    const aliases = ALIASES[field]
    let idx = norm.findIndex((h, i) => !used.has(i) && aliases.includes(h))
    if (idx < 0) idx = norm.findIndex((h, i) => !used.has(i) && aliases.some((a) => a.length > 3 && h.includes(a)))
    if (idx >= 0) {
      out[field] = idx
      used.add(idx)
    }
  }
  return out
}

/** Does the first row look like data (contains an e-mail) rather than headers? */
function firstRowIsData(row: string[]): boolean {
  return row.some((c) => isValidEmail(c))
}

// Without a header row, columns other than the e-mail column are read in this order.
const HEADERLESS_ORDER: TargetField[] = ['meno', 'klub', 'pozicia']

function tableFromMatrix(matrix: string[][]): Table {
  const rows = matrix.map((r) => r.map((c) => (c ?? '').toString().trim())).filter((r) => r.some((c) => c !== ''))
  if (rows.length === 0) return { headers: [], rows: [] }
  if (firstRowIsData(rows[0])) {
    const width = Math.max(...rows.map((r) => r.length))
    const emailCol = rows[0].findIndex((c) => isValidEmail(c))
    let next = 0
    const headers = Array.from({ length: width }, (_, i) =>
      i === emailCol ? 'email' : (HEADERLESS_ORDER[next++] ?? `Stĺpec ${i + 1}`),
    )
    return { headers, rows }
  }
  return { headers: rows[0], rows: rows.slice(1) }
}

const EMAIL_IN_TEXT = /[^\s<>,;"']+@[^\s<>,;"']+/g

/**
 * Pasted text, three accepted shapes:
 *  1. Table copied from Excel/Sheets (tab-separated), with or without a header row.
 *  2. One contact per line with fields separated by ";" or ",":
 *       email; meno; klub; pozícia   (header row optional; without it this order is assumed)
 *  3. A plain list of addresses separated by newlines, commas or semicolons ("Meno <email>" supported).
 */
export function parsePasted(text: string): Table {
  const trimmed = text.trim()
  if (!trimmed) return { headers: [], rows: [] }
  if (trimmed.includes('\t')) {
    return tableFromMatrix(trimmed.split(/\r?\n/).map((l) => l.split('\t')))
  }
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const delimiter = lines.some((l) => l.includes(';')) ? ';' : ','
  // A line is a "record" if it holds at most one address plus other non-empty fields.
  const isRecordLine = (l: string) => {
    const cells = l.split(delimiter).map((c) => c.trim())
    return cells.length > 1 && cells.some((c) => c && !isValidEmail(c) && !/<[^<>]+@[^<>]+>/.test(c))
  }
  const looksLikeTable =
    lines.every((l) => (l.match(EMAIL_IN_TEXT)?.length ?? 0) <= 1) && lines.some(isRecordLine)
  if (looksLikeTable) {
    const res = Papa.parse<string[]>(lines.join('\n'), { delimiter, skipEmptyLines: 'greedy' })
    return tableFromMatrix(res.data)
  }
  const rows: string[][] = []
  for (const token of trimmed.split(/[\n\r,;]+/)) {
    const t = token.trim()
    if (!t) continue
    const angle = /^(.*)<([^<>]+)>\s*$/.exec(t)
    if (angle) rows.push([angle[2].trim(), angle[1].trim().replace(/^"|"$/g, '')])
    else rows.push([t, ''])
  }
  return { headers: ['email', 'meno'], rows }
}

export function parseCsv(text: string): Table {
  const res = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy', delimiter: '' })
  return tableFromMatrix(res.data)
}

export async function parseFile(file: File): Promise<Table> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Súbor je príliš veľký (max 10 MB).')
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(await file.text())
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/browser')
    const data = await readSheet(file)
    return tableFromMatrix(
      data.map((row) =>
        row.map((cell) => {
          if (cell === null || cell === undefined) return ''
          if (cell instanceof Date) return cell.toISOString().slice(0, 10)
          return String(cell)
        }),
      ),
    )
  }
  throw new Error('Podporované sú súbory .csv a .xlsx.')
}

export interface ImportPreview {
  valid: ContactRow[]
  invalid: { row: number; value: string }[]
  duplicates: { row: number; email: string }[]
  suppressed: ContactRow[]
}

/** Applies the column mapping, validates, deduplicates (within the import and against `existing`). */
export function buildPreview(
  table: Table,
  mapping: Record<TargetField, number>,
  existing: Iterable<string> = [],
  suppressed: Set<string> = new Set(),
): ImportPreview {
  const seen = new Set([...existing].map(normalizeEmail))
  const out: ImportPreview = { valid: [], invalid: [], duplicates: [], suppressed: [] }
  const cell = (r: string[], f: TargetField) => (mapping[f] >= 0 ? (r[mapping[f]] ?? '').trim() : '')
  table.rows.forEach((r, i) => {
    const raw = cell(r, 'email')
    const email = normalizeEmail(raw.replace(/^mailto:/i, ''))
    if (!isValidEmail(email)) {
      out.invalid.push({ row: i + 1, value: raw })
      return
    }
    if (seen.has(email)) {
      out.duplicates.push({ row: i + 1, email })
      return
    }
    seen.add(email)
    const contact: ContactRow = {
      email,
      meno: cell(r, 'meno').slice(0, 200),
      klub: cell(r, 'klub').slice(0, 200),
      pozicia: cell(r, 'pozicia').slice(0, 200),
    }
    if (suppressed.has(email)) out.suppressed.push(contact)
    else out.valid.push(contact)
  })
  return out
}

/** CSV export cell, protected against spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return '\uFEFF' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}
