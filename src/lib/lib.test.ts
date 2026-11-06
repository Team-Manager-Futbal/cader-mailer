import { describe, expect, it } from 'vitest'
import { buildPreview, csvCell, guessMapping, normalizeHeader, parseCsv, parsePasted } from './import'
import { estimateMinutes, formatLocal, localToUtc, offsetMinutes } from './time'

describe('timezone Europe/Bratislava', () => {
  it('converts winter and summer wall time to UTC', () => {
    expect(localToUtc('2026-12-01', '08:00')).toEqual({ status: 'ok', utc: new Date('2026-12-01T07:00:00Z') })
    expect(localToUtc('2026-07-01', '08:00')).toEqual({ status: 'ok', utc: new Date('2026-07-01T06:00:00Z') })
    expect(offsetMinutes(Date.parse('2026-07-01T06:00:00Z'))).toBe(120)
  })

  it('rejects non-existent spring-forward times', () => {
    // 29 March 2026: 02:00 -> 03:00
    expect(localToUtc('2026-03-29', '02:30')).toEqual({ status: 'nonexistent' })
    expect(localToUtc('2026-03-29', '03:00').status).toBe('ok')
  })

  it('flags ambiguous fall-back times and picks the first occurrence', () => {
    // 25 October 2026: 03:00 -> 02:00
    const r = localToUtc('2026-10-25', '02:30')
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') {
      expect(r.utc.toISOString()).toBe('2026-10-25T00:30:00.000Z')
      expect(r.alternative.toISOString()).toBe('2026-10-25T01:30:00.000Z')
    }
  })

  it('rejects invalid dates', () => {
    expect(localToUtc('2026-02-30', '08:00').status).toBe('invalid')
    expect(localToUtc('2026-01-01', '24:00').status).toBe('invalid')
  })

  it('formats UTC instants in local time', () => {
    expect(formatLocal('2026-07-01T06:00:00Z')).toMatch(/1\. 7\. 2026.*08:00/)
  })

  it('estimates duration with rate and caps', () => {
    expect(estimateMinutes(200, 2, 60, 200)).toBe(60 * 3 + 10)
    expect(estimateMinutes(10, 2, 60, 200)).toBe(5)
    expect(estimateMinutes(0, 2, 60, 200)).toBe(0)
    expect(estimateMinutes(250, 10, 1000, 200)).toBe(24 * 60 + 5)
  })
})

describe('import', () => {
  it('splits pasted lists by newline, comma and semicolon and parses "Name <email>"', () => {
    const t = parsePasted('a@example.com, b@example.com;\nJán Novák <jan@example.com>\n\n')
    expect(t.rows).toEqual([
      ['a@example.com', ''],
      ['b@example.com', ''],
      ['jan@example.com', 'Ján Novák'],
    ])
  })

  it('reads one contact per line as "email; meno; klub; pozícia" without Excel', () => {
    const t = parsePasted('jan@example.com; Ján Novák; FK Senec; tréner\nmaria@example.com; Mária; TJ Vzor\n')
    expect(t.headers).toEqual(['email', 'meno', 'klub', 'pozicia'])
    expect(guessMapping(t.headers)).toEqual({ email: 0, meno: 1, klub: 2, pozicia: 3 })
    expect(buildPreview(t, guessMapping(t.headers)).valid).toEqual([
      { email: 'jan@example.com', meno: 'Ján Novák', klub: 'FK Senec', pozicia: 'tréner' },
      { email: 'maria@example.com', meno: 'Mária', klub: 'TJ Vzor', pozicia: '' },
    ])
  })

  it('accepts a header row and commas in pasted records', () => {
    const t = parsePasted('klub, email, meno\nFK Senec, jan@example.com, Ján\n"MFK Ružomberok, a.s.", info@example.com, Peter')
    const p = buildPreview(t, guessMapping(t.headers))
    expect(p.valid).toEqual([
      { email: 'jan@example.com', meno: 'Ján', klub: 'FK Senec', pozicia: '' },
      { email: 'info@example.com', meno: 'Peter', klub: 'MFK Ružomberok, a.s.', pozicia: '' },
    ])
  })

  it('still treats comma/semicolon separated addresses on one line as a plain list', () => {
    expect(parsePasted('a@example.com; b@example.com, c@example.com').rows.map((r) => r[0])).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ])
    expect(parsePasted('a@example.com\nb@example.com').rows).toHaveLength(2)
  })

  it('maps Slovak and English headers case/diacritics-insensitively', () => {
    expect(normalizeHeader('  E-mailová   Adresa ')).toBe('e-mailova adresa')
    expect(guessMapping(['Názov klubu', 'Kontaktná osoba', 'E-mail', 'Funkcia'])).toEqual({
      email: 2,
      meno: 1,
      klub: 0,
      pozicia: 3,
    })
    expect(guessMapping(['EMAIL', 'Meno', 'Klub', 'Pozícia'])).toEqual({ email: 0, meno: 1, klub: 2, pozicia: 3 })
  })

  it('parses CSV with ; delimiter and BOM, and headerless CSV', () => {
    const t = parseCsv('\uFEFFemail;meno;klub\nA@example.com;Ján;FK Senec\n')
    expect(t.headers).toEqual(['email', 'meno', 'klub'])
    expect(t.rows).toEqual([['A@example.com', 'Ján', 'FK Senec']])
    const h = parseCsv('FK Senec,a@example.com\nFK Pezinok,b@example.com')
    expect(h.headers).toEqual(['meno', 'email'])
    expect(h.rows).toHaveLength(2)
  })

  it('validates, dedups (also against existing recipients) and separates suppressed', () => {
    const table = {
      headers: ['email', 'meno'],
      rows: [['A@example.com', 'A'], ['a@example.com ', 'dup'], ['zly-email', ''], ['b@example.com', 'B'], ['c@example.com', 'C'], ['mailto:d@example.com', 'D']],
    }
    const p = buildPreview(table, { email: 0, meno: 1, klub: -1, pozicia: -1 }, ['c@example.com'], new Set(['b@example.com']))
    expect(p.valid.map((r) => r.email)).toEqual(['a@example.com', 'd@example.com'])
    expect(p.duplicates.map((d) => d.email)).toEqual(['a@example.com', 'c@example.com'])
    expect(p.invalid).toEqual([{ row: 3, value: 'zly-email' }])
    expect(p.suppressed.map((r) => r.email)).toEqual(['b@example.com'])
  })

  it('protects CSV exports against formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+421 900')).toBe("'+421 900")
    expect(csvCell('FK Senec')).toBe('FK Senec')
  })
})
