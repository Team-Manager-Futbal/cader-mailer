// Public opt-out endpoint (no JWT). Only POST performs the unsubscribe, so link
// previews/scanners that issue GET requests cannot trigger it accidentally.
//   * RFC 8058 one-click: POST ?t=<token>  body "List-Unsubscribe=One-Click"
//   * Frontend confirmation page: POST {"token": "<token>"}
// Responses never reveal whether a token exists or which address it belongs to.
import { corsHeaders, preflight, serviceClient } from '../_shared/runtime.ts'

const TOKEN = /^[0-9a-f]{64}$/

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre
  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ message: 'Na odhlásenie použite tlačidlo na stránke s potvrdením.' }), { status: 200, headers })
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers })

  let token = new URL(req.url).searchParams.get('t') ?? ''
  if (!token) {
    const type = req.headers.get('content-type') ?? ''
    try {
      if (type.includes('application/json')) token = String((await req.json())?.token ?? '')
    } catch {
      token = ''
    }
  }
  if (TOKEN.test(token)) {
    const { error } = await serviceClient().rpc('unsubscribe_by_token', { p_token: token })
    if (error) {
      console.error('unsubscribe failed', error.message)
      return new Response(JSON.stringify({ ok: false }), { status: 500, headers })
    }
  }
  // Same response for valid and invalid tokens (no enumeration oracle).
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers })
})
