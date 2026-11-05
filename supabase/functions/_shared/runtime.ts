// Deno-only helpers shared by the Edge Functions (not imported by the frontend or unit tests).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import type { Connector } from './smtp.ts'

export function env(name: string, required = true): string {
  const v = Deno.env.get(name) ?? ''
  if (required && !v) throw new Error(`Missing environment variable ${name}`)
  return v
}

/** service_role client. Bypasses RLS: every caller must be authorised BEFORE using it. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Client acting as the calling user (RLS + RPC permission checks apply). */
export function userClient(authHeader: string): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  })
}

// ---------------------------------------------------------------------------
// HTTP / CORS
// ---------------------------------------------------------------------------
function allowedOrigins(): string[] {
  return (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
  if (allowedOrigins().includes(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  const origin = req.headers.get('origin') ?? ''
  if (!allowedOrigins().includes(origin)) return new Response(null, { status: 403 })
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req)
    if (pre) return pre
    if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405)
    try {
      return await fn(req)
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.code, message: e.message }, e.status)
      // Never echo internals; log only the message (no request bodies, no secrets).
      console.error('unhandled', e instanceof Error ? e.message : String(e))
      return json(req, { error: 'internal_error' }, 500)
    }
  }
}

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------
export interface Caller {
  id: string
  email: string
  role: 'admin' | 'member'
  authHeader: string
}

export async function requireCaller(req: Request, opts: { admin?: boolean } = {}): Promise<Caller> {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'unauthenticated')
  const db = serviceClient()
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'unauthenticated')
  const { data: profile } = await db
    .from('profiles')
    .select('user_id, email, role, active')
    .eq('user_id', data.user.id)
    .maybeSingle()
  if (!profile || !profile.active) throw new HttpError(403, 'not_authorized', 'Účet nie je aktívny.')
  if (opts.admin && profile.role !== 'admin') throw new HttpError(403, 'not_authorized', 'Vyžaduje rolu admin.')
  return { id: profile.user_id, email: profile.email, role: profile.role, authHeader }
}

export async function audit(db: SupabaseClient, actor: string | null, action: string, entity: string, entityId: string, details: Record<string, unknown> = {}) {
  await db.from('audit_logs').insert({ actor_id: actor, action, entity, entity_id: entityId, details })
}

export async function readJson<T>(req: Request, parse: (v: unknown) => T): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
  try {
    return parse(body)
  } catch {
    throw new HttpError(400, 'invalid_input')
  }
}

// ---------------------------------------------------------------------------
// SMTP over Deno TLS
// ---------------------------------------------------------------------------
export const denoTlsConnector: Connector = async (host, port) => {
  const conn = await Deno.connectTls({ hostname: host, port })
  return {
    async read() {
      const buf = new Uint8Array(16 * 1024)
      const n = await conn.read(buf)
      return n === null ? null : buf.subarray(0, n)
    },
    async write(data) {
      let off = 0
      while (off < data.length) off += await conn.write(data.subarray(off))
    },
    close() {
      try {
        conn.close()
      } catch {
        // already closed
      }
    },
  }
}
