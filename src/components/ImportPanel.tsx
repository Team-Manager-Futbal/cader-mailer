import { useMemo, useState } from 'react'
import { buildPreview, FIELD_LABELS, guessMapping, parseFile, parsePasted, type ContactRow, type Table, TARGET_FIELDS, type TargetField } from '../lib/import'
import { supabase } from '../lib/supabase'
import { Alert, Button, Field, Select, Textarea } from './ui'

/** Paste / CSV / XLSX import with column mapping and a validation summary. */
export function ImportPanel({ existing, onImport }: { existing: string[]; onImport: (rows: ContactRow[]) => Promise<void> }) {
  const [text, setText] = useState('')
  const [table, setTable] = useState<Table | null>(null)
  const [mapping, setMapping] = useState<Record<TargetField, number>>({ email: -1, meno: -1, klub: -1, pozicia: -1 })
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(t: Table) {
    setError(null)
    if (t.rows.length === 0) {
      setError('Nenašli sa žiadne riadky.')
      setTable(null)
      return
    }
    if (t.rows.length > 5000) {
      setError('Naraz možno importovať najviac 5000 riadkov.')
      return
    }
    const m = guessMapping(t.headers)
    setTable(t)
    setMapping(m)
    // Check the team suppression list for the candidate addresses.
    const emails = [...new Set(t.rows.map((r) => (m.email >= 0 ? r[m.email] : '')?.trim().toLowerCase()).filter(Boolean))]
    const found = new Set<string>()
    for (let i = 0; i < emails.length; i += 200) {
      const { data } = await supabase.from('suppression_list').select('email_normalized').in('email_normalized', emails.slice(i, i + 200))
      for (const r of data ?? []) found.add(r.email_normalized)
    }
    setSuppressed(found)
  }

  const preview = useMemo(() => (table ? buildPreview(table, mapping, existing, suppressed) : null), [table, mapping, existing, suppressed])

  async function onFile(file: File | undefined) {
    if (!file) return
    try {
      await load(await parseFile(file))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Súbor sa nepodarilo načítať.')
    }
  }

  async function confirm() {
    if (!preview) return
    setBusy(true)
    try {
      await onImport(preview.valid)
      setTable(null)
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import zlyhal.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Vložiť kontakty"
          htmlFor="paste"
          hint={
            <>
              Jeden kontakt na riadok v poradí <strong>email; meno; klub; pozícia</strong> (stačí aj len e-mail, ostatné môžete vynechať). Funguje aj prvý riadok s hlavičkou alebo tabuľka
              skopírovaná z Excelu.
            </>
          }
        >
          <Textarea
            id="paste"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'sekretariat@fkpriklad.sk; Ján Novák; FK Príklad; športový riaditeľ\ninfo@tjvzor.sk; Mária Kováčová; TJ Vzor'}
          />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-medium text-stone-800">alebo nahrať súbor</p>
          <label className="flex h-[8.4rem] cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-stone-300 bg-stone-50 text-sm text-stone-600 hover:bg-stone-100">
            <span className="font-medium text-stone-800">Vybrať .csv alebo .xlsx</span>
            <span className="text-xs">Stĺpce: email, meno, klub, pozícia (voliteľné)</span>
            <input type="file" accept=".csv,.xlsx,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        </div>
      </div>
      <Button onClick={() => load(parsePasted(text))} disabled={!text.trim()}>
        Skontrolovať vložené kontakty
      </Button>

      {error && <Alert tone="error">{error}</Alert>}

      {table && preview && (
        <div className="space-y-4 rounded-md bg-stone-50 p-4 ring-1 ring-stone-200">
          <div className="grid gap-3 sm:grid-cols-4">
            {TARGET_FIELDS.map((f) => (
              <Field key={f} label={`Stĺpec pre ${FIELD_LABELS[f].toLowerCase()}`} htmlFor={`map-${f}`}>
                <Select id={`map-${f}`} value={mapping[f]} onChange={(e) => setMapping({ ...mapping, [f]: Number(e.target.value) })}>
                  <option value={-1}>{f === 'email' ? '– vyberte –' : '– nepoužiť –'}</option>
                  {table.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Stĺpec ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <li>
              <strong className="tabular-nums">{preview.valid.length}</strong> platných
            </li>
            <li className={preview.invalid.length ? 'text-red-700' : ''}>
              <strong className="tabular-nums">{preview.invalid.length}</strong> neplatných
            </li>
            <li>
              <strong className="tabular-nums">{preview.duplicates.length}</strong> duplicít
            </li>
            <li className={preview.suppressed.length ? 'text-amber-800' : ''}>
              <strong className="tabular-nums">{preview.suppressed.length}</strong> odhlásených (nebudú pridané)
            </li>
          </ul>
          {preview.invalid.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-red-700">Zobraziť neplatné riadky</summary>
              <ul className="mt-2 max-h-40 overflow-auto font-mono text-xs">
                {preview.invalid.slice(0, 200).map((r) => (
                  <li key={r.row}>
                    riadok {r.row}: {r.value || '(prázdne)'}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.valid.length > 0 && (
            <div className="max-h-56 overflow-auto rounded bg-white ring-1 ring-stone-200">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-stone-100">
                  <tr>
                    {TARGET_FIELDS.map((f) => (
                      <th key={f} className="px-2 py-1 text-left font-semibold">
                        {FIELD_LABELS[f]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.valid.slice(0, 50).map((r) => (
                    <tr key={r.email} className="border-t border-stone-100">
                      <td className="px-2 py-1">{r.email}</td>
                      <td className="px-2 py-1">{r.meno}</td>
                      <td className="px-2 py-1">{r.klub}</td>
                      <td className="px-2 py-1">{r.pozicia}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.valid.length > 50 && <p className="px-2 py-1 text-xs text-stone-500">… a ďalších {preview.valid.length - 50}</p>}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={confirm} busy={busy} disabled={mapping.email < 0 || preview.valid.length === 0}>
              Pridať {preview.valid.length} príjemcov
            </Button>
            <Button variant="ghost" onClick={() => setTable(null)}>
              Zrušiť
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
