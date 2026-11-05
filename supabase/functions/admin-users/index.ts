// Admin-only user management: invite (invitation-only sign-up), role/active changes.
import { z } from 'npm:zod@4.6.7'
import { audit, env, handle, HttpError, json, readJson, requireCaller, serviceClient, userClient } from '../_shared/runtime.ts'

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('invite'),
    email: z.email().trim().toLowerCase(),
    full_name: z.string().trim().max(200).default(''),
    role: z.enum(['admin', 'member']).default('member'),
  }),
  z.object({
    action: z.literal('update'),
    user_id: z.uuid(),
    role: z.enum(['admin', 'member']),
    active: z.boolean(),
    full_name: z.string().trim().max(200).optional(),
  }),
])

Deno.serve(
  handle(async (req) => {
    const caller = await requireCaller(req, { admin: true })
    const input = await readJson(req, (v) => Body.parse(v))
    const db = serviceClient()

    if (input.action === 'invite') {
      const { data: existing } = await db.from('profiles').select('user_id').ilike('email', input.email).maybeSingle()
      if (existing) throw new HttpError(409, 'already_exists', 'Používateľ s touto adresou už existuje.')
      const { data, error } = await db.auth.admin.inviteUserByEmail(input.email, {
        redirectTo: env('SITE_URL'),
        data: { full_name: input.full_name },
      })
      if (error || !data.user) throw new HttpError(400, 'invite_failed', 'Pozvánku sa nepodarilo odoslať. Skontrolujte nastavenia Auth/SMTP v Supabase.')
      // Profile row is created by the auth trigger (inactive); the admin invite activates it.
      const { error: pErr } = await db
        .from('profiles')
        .update({ active: true, role: input.role, full_name: input.full_name })
        .eq('user_id', data.user.id)
      if (pErr) throw new HttpError(500, 'profile_update_failed')
      await audit(db, caller.id, 'user.invite', 'profile', data.user.id, { role: input.role })
      return json(req, { ok: true, user_id: data.user.id })
    }

    // Role/active changes go through the RPC as the calling admin, so the DB enforces
    // "no self-demotion" and "keep at least one admin".
    const { error } = await userClient(caller.authHeader).rpc('admin_update_profile', {
      p_user: input.user_id,
      p_role: input.role,
      p_active: input.active,
      p_full_name: input.full_name ?? null,
    })
    if (error) {
      const code = error.message.match(/cannot_demote_self|last_admin|user_not_found|not_authorized/)?.[0] ?? 'update_failed'
      throw new HttpError(400, code)
    }
    // Deactivated users also lose their sessions at the Auth level.
    await db.auth.admin.updateUserById(input.user_id, { ban_duration: input.active ? 'none' : '876000h' })
    return json(req, { ok: true })
  }),
)
