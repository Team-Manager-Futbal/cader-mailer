// Europe/Bratislava wall-clock <-> UTC, with explicit DST handling.
export const TZ = 'Europe/Bratislava'

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function zonedParts(utcMs: number) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second }
}

/** Offset of Bratislava from UTC in minutes at a given instant (+60 winter, +120 summer). */
export function offsetMinutes(utcMs: number): number {
  const z = zonedParts(utcMs)
  const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.h, z.min, z.s)
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000)
}

export type LocalToUtc =
  | { status: 'ok'; utc: Date }
  /** Clock goes back (last Sunday of October): the time occurs twice. We pick the FIRST occurrence. */
  | { status: 'ambiguous'; utc: Date; alternative: Date }
  /** Clock jumps forward (last Sunday of March): the time does not exist. */
  | { status: 'nonexistent' }
  | { status: 'invalid' }

/** `date` = YYYY-MM-DD, `time` = HH:MM, both as Bratislava wall clock. */
export function localToUtc(date: string, time: string): LocalToUtc {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const tm = /^(\d{2}):(\d{2})$/.exec(time)
  if (!dm || !tm) return { status: 'invalid' }
  const [y, mo, d, h, mi] = [+dm[1], +dm[2], +dm[3], +tm[1], +tm[2]]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return { status: 'invalid' }
  const naive = Date.UTC(y, mo - 1, d, h, mi)
  const check = new Date(naive)
  if (check.getUTCDate() !== d || check.getUTCMonth() !== mo - 1) return { status: 'invalid' }
  const offsets = new Set([offsetMinutes(naive - 12 * 3600e3), offsetMinutes(naive + 12 * 3600e3)])
  const candidates = [...offsets]
    .map((off) => naive - off * 60000)
    .filter((t) => offsetMinutes(t) * 60000 === naive - t)
    .sort((a, b) => a - b)
  if (candidates.length === 0) return { status: 'nonexistent' }
  if (candidates.length > 1) return { status: 'ambiguous', utc: new Date(candidates[0]), alternative: new Date(candidates[1]) }
  return { status: 'ok', utc: new Date(candidates[0]) }
}

const displayFmt = new Intl.DateTimeFormat('sk-SK', {
  timeZone: TZ,
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** Display a UTC timestamp in Bratislava time, e.g. "6. 11. 2026 08:00". */
export function formatLocal(iso: string | Date | null | undefined): string {
  if (!iso) return '–'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return '–'
  return displayFmt.format(d)
}

/** Current Bratislava date/time as input values (YYYY-MM-DD, HH:MM). */
export function localInputs(at: Date): { date: string; time: string } {
  const z = zonedParts(at.getTime())
  const p = (n: number) => String(n).padStart(2, '0')
  return { date: `${z.y}-${p(z.m)}-${p(z.d)}`, time: `${p(z.h)}:${p(z.min)}` }
}

/**
 * Rough, NON-guaranteed duration estimate in minutes for sending `count` messages, simulating
 * one queue run per minute with the campaign rate and the sender's rolling hourly/daily caps.
 * Ignores other campaigns on the same sender, retries and worker delays.
 */
export function estimateMinutes(count: number, ratePerMinute: number, hourlyCap: number, dailyCap: number): number {
  if (count <= 0) return 0
  const perMinute: number[] = []
  let sent = 0
  let minute = 0
  const maxMinutes = 60 * 24 * 90
  while (sent < count && minute < maxMinutes) {
    let lastHour = 0
    let lastDay = 0
    for (let i = Math.max(0, minute - 1439); i < minute; i++) {
      lastDay += perMinute[i]
      if (i >= minute - 59) lastHour += perMinute[i]
    }
    const n = Math.max(0, Math.min(ratePerMinute, hourlyCap - lastHour, dailyCap - lastDay, count - sent))
    perMinute.push(n)
    sent += n
    minute++
  }
  return minute
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`
  const d = Math.floor(h / 24)
  return `${d} d ${h % 24} h`
}
