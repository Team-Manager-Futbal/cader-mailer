export const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase()
}

export function isValidEmail(e: string): boolean {
  const n = normalizeEmail(e)
  return n.length <= 254 && EMAIL_RE.test(n)
}
