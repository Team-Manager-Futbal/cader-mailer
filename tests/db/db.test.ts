import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, Db } from './helpers'

let db: Db
let admin: string
let alice: string
let bob: string
let inactive: string
let sender: string
let otherSender: string

const rows = (n: number, prefix = 'klub') =>
  Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com`, meno: `Meno ${i}`, klub: `FK ${i}` }))

async function newCampaign(owner: string, senderId: string | null = sender, name = 'Test') {
  const [c] = await db.as<{ id: string }>(
    owner,
    `insert into public.campaigns (owner_id, sender_id, name, subject, body_text)
     values ($1, $2, $3, 'Dobrý deň {klub}', 'Ahoj {meno}') returning id`,
    [owner, senderId, name],
  )
  return c.id
}

async function confirm(owner: string, campaign: string, rate = 2, at = 'now()') {
  await db.as(
    owner,
    `select public.campaign_confirm($1, ${at}, $2, 'public_business_contact', null, true)`,
    [campaign, rate],
  )
}

const claim = (max = 10, lease = 300) =>
  db.as<{ recipient_id: string; lease_token: string; attempt_id: string; email: string; campaign_id: string }>(
    'service_role',
    `select * from public.claim_due_recipients($1, $2)`,
    [max, lease],
  )

const finish = (r: { recipient_id: string; lease_token: string; attempt_id: string }, outcome: string, category: string | null = null) =>
  db.as<{ finish_attempt: boolean }>(
    'service_role',
    `select public.finish_attempt($1, $2, $3, $4, 250, $5, null, '<id@test>')`,
    [r.recipient_id, r.lease_token, r.attempt_id, outcome, category],
  )

beforeAll(async () => {
  db = new Db(await createTestDatabase('cader_mailer_test'))
})
afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  await db.sql(`truncate public.audit_logs, public.send_attempts, public.campaign_recipients, public.campaigns,
    public.templates, public.sender_permissions, public.sender_secrets, public.sender_accounts,
    public.suppression_list, auth.users cascade`)
  await db.sql(`update public.app_settings set sending_enabled = true, max_member_rate_per_minute = 2`)
  admin = await db.createUser('admin@example.com', { role: 'admin' })
  alice = await db.createUser('alice@example.com')
  bob = await db.createUser('bob@example.com')
  inactive = await db.createUser('selfsignup@example.com', { active: false })
  sender = await db.createSender('jakub@example.com', { rate: 2 })
  otherSender = await db.createSender('other@example.com')
  await db.sql(`insert into public.sender_permissions (user_id, sender_id) values ($1, $2), ($3, $2)`, [alice, sender, bob])
})

describe('access control', () => {
  it('new auth users get an inactive member profile (fail closed)', async () => {
    const [p] = await db.sql(`select role, active from public.profiles where user_id = $1`, [inactive])
    expect(p).toEqual({ role: 'member', active: false })
  })

  it('anon cannot read any table or call RPCs', async () => {
    for (const t of ['profiles', 'campaigns', 'campaign_recipients', 'sender_accounts', 'suppression_list', 'app_settings']) {
      await expect(db.as('anon', `select * from public.${t}`)).rejects.toThrow(/permission denied/)
    }
    await expect(db.as('anon', `select public.unsubscribe_by_token('x')`)).rejects.toThrow(/permission denied/)
  })

  it('inactive users see nothing and cannot create campaigns', async () => {
    await newCampaign(alice)
    expect(await db.as(inactive, `select * from public.campaigns`)).toHaveLength(0)
    expect(await db.as(inactive, `select * from public.app_settings`)).toHaveLength(0)
    await expect(newCampaign(inactive, null)).rejects.toThrow(/row-level security/)
  })

  it('members only see their own campaigns and recipients; admin sees all', async () => {
    const c = await newCampaign(alice)
    await db.as(alice, `select public.campaign_set_recipients($1, $2::jsonb)`, [c, JSON.stringify(rows(3))])
    expect(await db.as(bob, `select * from public.campaigns`)).toHaveLength(0)
    expect(await db.as(bob, `select * from public.campaign_recipients`)).toHaveLength(0)
    expect(await db.as(admin, `select * from public.campaigns`)).toHaveLength(1)
    expect(await db.as(admin, `select * from public.campaign_recipients`)).toHaveLength(3)
    await expect(
      db.as(bob, `select public.campaign_set_recipients($1, $2::jsonb)`, [c, JSON.stringify(rows(1))]),
    ).rejects.toThrow(/not_authorized/)
    await expect(db.as(bob, `select public.campaign_set_status($1, 'cancel')`, [c])).rejects.toThrow(/not_authorized/)
  })

  it('members cannot use a sender that was not assigned to them', async () => {
    await expect(newCampaign(alice, otherSender)).rejects.toThrow(/row-level security/)
    const c = await newCampaign(alice)
    await db.as(alice, `update public.campaigns set sender_id = $2 where id = $1`, [c, otherSender]).catch((e) => e)
    const [row] = await db.sql(`select sender_id from public.campaigns where id = $1`, [c])
    expect(row.sender_id).toBe(sender)
    expect(await db.as(alice, `select id from public.sender_accounts`)).toEqual([{ id: sender }])
  })

  it('members cannot change status/confirmation columns directly', async () => {
    const c = await newCampaign(alice)
    await expect(db.as(alice, `update public.campaigns set status = 'processing' where id = $1`, [c])).rejects.toThrow(
      /permission denied/,
    )
    await expect(
      db.as(alice, `update public.campaigns set confirmed_at = now() where id = $1`, [c]),
    ).rejects.toThrow(/permission denied/)
  })

  it('members cannot invite, grant senders, edit roles, read secrets or run the worker', async () => {
    await expect(
      db.as(alice, `insert into public.sender_permissions (user_id, sender_id, granted_by) values ($1, $2, $1)`, [alice, otherSender]),
    ).rejects.toThrow(/row-level security/)
    await expect(db.as(alice, `select * from public.sender_secrets`)).rejects.toThrow(/permission denied/)
    await expect(
      db.as(alice, `select public.admin_update_profile($1, 'admin', true)`, [alice]),
    ).rejects.toThrow(/not_authorized/)
    await expect(db.as(alice, `select * from public.claim_due_recipients(10, 60)`)).rejects.toThrow(/permission denied/)
    await expect(db.as(alice, `select public.finish_attempt(null, null, null, 'x', null, null, null, null)`)).rejects.toThrow(
      /permission denied/,
    )
    await expect(db.as(alice, `update public.sender_accounts set active = true where id = $1`, [sender])).resolves.toEqual([])
    const [s] = await db.sql(`select credential_set from public.sender_accounts where id = $1`, [sender])
    expect(s.credential_set).toBe(true)
    await expect(db.as(alice, `select * from public.audit_logs`)).resolves.toHaveLength(0)
  })

  it('admin cannot remove the last admin or demote themself', async () => {
    await expect(db.as(admin, `select public.admin_update_profile($1, 'member', true)`, [admin])).rejects.toThrow(
      /cannot_demote_self/,
    )
    await db.as(admin, `select public.admin_update_profile($1, 'admin', true)`, [alice])
    await db.as(admin, `select public.admin_update_profile($1, 'member', true)`, [alice])
    const [p] = await db.sql(`select role from public.profiles where user_id = $1`, [alice])
    expect(p.role).toBe('member')
  })

  it('changing SMTP connection data invalidates the last successful test', async () => {
    await db.as(admin, `update public.sender_accounts set smtp_host = 'smtp.example.com' where id = $1`, [sender])
    const [s] = await db.sql(`select last_test_ok from public.sender_accounts where id = $1`, [sender])
    expect(s.last_test_ok).toBeNull()
  })
})

describe('recipients import', () => {
  it('revalidates, deduplicates by normalized e-mail and filters suppressed addresses', async () => {
    await db.sql(`insert into public.suppression_list (email_normalized) values ('blocked@example.com')`)
    const c = await newCampaign(alice)
    const input = [
      { email: 'A@Example.com', meno: 'A' },
      { email: ' a@example.com ', meno: 'dup' },
      { email: 'not-an-email' },
      { email: 'Blocked@example.com' },
      { email: 'b@example.com', klub: '<script>alert(1)</script>' },
    ]
    const [res] = await db.as(alice, `select public.campaign_set_recipients($1, $2::jsonb) as r`, [c, JSON.stringify(input)])
    expect(res.r).toEqual({ added: 2, invalid: 1, duplicate: 1, suppressed: 1, total: 2 })
    const stored = await db.sql(`select email_normalized, klub from public.campaign_recipients order by 1`)
    expect(stored.map((r) => r.email_normalized)).toEqual(['a@example.com', 'b@example.com'])
    // Stored as plain text; rendering is plain text only.
    expect(stored[1].klub).toBe('<script>alert(1)</script>')
  })

  it('accepts 200 recipients in one call', async () => {
    const c = await newCampaign(alice)
    const [res] = await db.as(alice, `select public.campaign_set_recipients($1, $2::jsonb) as r`, [c, JSON.stringify(rows(200))])
    expect(res.r.added).toBe(200)
  })
})

describe('campaign confirmation', () => {
  it('requires acknowledgement, a ready sender and a rate within member bounds', async () => {
    const c = await newCampaign(alice)
    await db.as(alice, `select public.campaign_set_recipients($1, $2::jsonb)`, [c, JSON.stringify(rows(2))])
    await expect(
      db.as(alice, `select public.campaign_confirm($1, now(), 2, 'public_business_contact', null, false)`, [c]),
    ).rejects.toThrow(/acknowledgement_required/)
    await expect(confirm(alice, c, 5)).rejects.toThrow(/rate_not_allowed/)
    await expect(confirm(alice, c, 2, `now() - interval '1 hour'`)).rejects.toThrow(/schedule_in_past/)
    await db.sql(`update public.sender_accounts set last_test_ok = false where id = $1`, [sender])
    await expect(confirm(alice, c)).rejects.toThrow(/sender_not_ready/)
    await db.sql(`update public.sender_accounts set last_test_ok = true where id = $1`, [sender])
    await confirm(alice, c)
    const [row] = await db.sql(`select status, legal_basis from public.campaigns where id = $1`, [c])
    expect(row).toEqual({ status: 'scheduled', legal_basis: 'public_business_contact' })
    // Confirmed campaigns can no longer be edited directly.
    expect(await db.as(alice, `update public.campaigns set subject = 'x' where id = $1 returning id`, [c])).toHaveLength(0)
  })

  it('rejects a campaign with no sendable recipients', async () => {
    const c = await newCampaign(alice)
    await expect(confirm(alice, c)).rejects.toThrow(/no_recipients/)
  })
})

describe('queue processing', () => {
  async function readyCampaign(n: number, owner = alice) {
    const c = await newCampaign(owner)
    await db.as(owner, `select public.campaign_set_recipients($1, $2::jsonb)`, [c, JSON.stringify(rows(n, `c${n}-`))])
    await confirm(owner, c)
    return c
  }

  it('sends nothing while the global kill switch is off', async () => {
    await readyCampaign(3)
    await db.sql(`update public.app_settings set sending_enabled = false`)
    expect(await claim()).toHaveLength(0)
    const [c] = await db.sql(`select status from public.campaigns`)
    expect(c.status).toBe('processing')
  })

  it('does not start a campaign before its scheduled time', async () => {
    const c = await newCampaign(alice)
    await db.as(alice, `select public.campaign_set_recipients($1, $2::jsonb)`, [c, JSON.stringify(rows(2))])
    await confirm(alice, c, 2, `now() + interval '1 hour'`)
    expect(await claim()).toHaveLength(0)
  })

  it('respects the per-sender rate across campaigns and claims each recipient once', async () => {
    await readyCampaign(5)
    await readyCampaign(4, bob)
    const first = await claim(50)
    expect(first).toHaveLength(2)
    expect(await claim(50)).toHaveLength(0)
    // Pretend a minute passed.
    await db.sql(`update public.send_attempts set created_at = created_at - interval '61 seconds'`)
    const second = await claim(50)
    expect(second).toHaveLength(2)
    const ids = new Set([...first, ...second].map((r) => r.recipient_id))
    expect(ids.size).toBe(4)
  })

  it('two workers racing never claim the same recipient or exceed the cap', async () => {
    await db.sql(`update public.sender_accounts set rate_per_minute = 25 where id = $1`, [sender])
    await db.sql(`insert into public.sender_permissions (user_id, sender_id) values ($1, $2)`, [admin, sender])
    const c = await newCampaign(admin)
    await db.as(admin, `select public.campaign_set_recipients($1, $2::jsonb)`, [c, JSON.stringify(rows(40))])
    await confirm(admin, c, 25)
    // Start the campaign first, so only the claim's own locking protects the race below.
    await db.sql(`update public.app_settings set sending_enabled = false`)
    expect(await claim()).toHaveLength(0)
    await db.sql(`update public.app_settings set sending_enabled = true`)
    // Worker A claims inside a transaction that stays open (slow commit).
    const a = await db.openServiceTx()
    const fromA = await a.query<{ recipient_id: string }>(`select * from public.claim_due_recipients(10, 300)`)
    expect(fromA).toHaveLength(10)
    // Worker B runs concurrently while A has not committed yet.
    const pendingB = claim(50)
    await new Promise((r) => setTimeout(r, 300))
    await a.commit()
    const fromB = await pendingB
    const ids = [...fromA, ...fromB].map((r) => r.recipient_id)
    expect(new Set(ids).size).toBe(ids.length)
    // Combined claims respect the sender's per-minute cap of 25.
    expect(ids.length).toBe(25)
    const [{ n }] = await db.sql(`select count(*)::int as n from public.send_attempts`)
    expect(n).toBe(25)
  })

  it('obeys suppression right before claim', async () => {
    await readyCampaign(2)
    await db.sql(`insert into public.suppression_list (email_normalized) values ('c2-0@example.com')`)
    const claimed = await claim()
    expect(claimed.map((r) => r.email)).toEqual(['c2-1@example.com'])
    const [r] = await db.sql(`select state from public.campaign_recipients where email_normalized = 'c2-0@example.com'`)
    expect(r.state).toBe('skipped_unsubscribed')
  })

  it('pause stops further claims; resume continues; cancel cancels the rest', async () => {
    const c = await readyCampaign(6)
    await db.sql(`update public.sender_accounts set rate_per_minute = 50 where id = $1`, [sender])
    await db.sql(`update public.campaigns set rate_per_minute = 1 where id = $1`, [c])
    const [one] = await claim()
    await db.as(alice, `select public.campaign_set_status($1, 'pause')`, [c])
    // The in-flight message sees the pause before talking to SMTP.
    const [still] = await db.as('service_role', `select public.recipient_still_sendable($1, $2) as ok`, [
      one.recipient_id,
      one.lease_token,
    ])
    expect(still.ok).toBe(false)
    await db.as('service_role', `select public.release_unsent($1, $2, $3)`, [one.recipient_id, one.lease_token, one.attempt_id])
    await db.sql(`update public.send_attempts set created_at = created_at - interval '61 seconds'`)
    expect(await claim()).toHaveLength(0)
    await db.as(alice, `select public.campaign_set_status($1, 'resume')`, [c])
    expect(await claim()).toHaveLength(1)
    await db.as(alice, `select public.campaign_set_status($1, 'cancel')`, [c])
    const states = await db.sql(`select state, count(*)::int from public.campaign_recipients group by 1 order by 1`)
    expect(states).toEqual([
      { state: 'processing', count: 1 },
      { state: 'cancelled', count: 5 },
    ])
  })

  it('accepted results complete the campaign', async () => {
    const c = await readyCampaign(2)
    for (const r of await claim()) expect((await finish(r, 'accepted_by_smtp'))[0].finish_attempt).toBe(true)
    const [row] = await db.sql(`select status from public.campaigns where id = $1`, [c])
    expect(row.status).toBe('completed')
  })

  it('transient failures back off and become permanent after 3 attempts', async () => {
    await readyCampaign(1)
    for (let i = 0; i < 3; i++) {
      await db.sql(`update public.campaign_recipients set next_attempt_at = now() - interval '1 second' where next_attempt_at is not null`)
      await db.sql(`update public.send_attempts set created_at = created_at - interval '2 minutes'`)
      const [r] = await claim()
      expect(r).toBeDefined()
      await finish(r, 'temporary_failure', 'transient')
    }
    const [row] = await db.sql(`select state, attempts from public.campaign_recipients`)
    expect(row).toEqual({ state: 'permanent_failure', attempts: 3 })
  })

  it('provider limit/block pauses all campaigns of the sender and blocks it until an admin acts', async () => {
    const c1 = await readyCampaign(3)
    const c2 = await readyCampaign(3, bob)
    const [r] = await claim(1)
    await finish(r, 'temporary_failure', 'rate_limit')
    const camps = await db.sql(`select status from public.campaigns where id = any($1)`, [[c1, c2]])
    expect(camps.every((x) => x.status === 'paused')).toBe(true)
    const [s] = await db.sql(`select blocked_until is not null as blocked from public.sender_accounts where id = $1`, [sender])
    expect(s.blocked).toBe(true)
    await db.as(alice, `select public.campaign_set_status($1, 'resume')`, [c1])
    await db.sql(`update public.send_attempts set created_at = created_at - interval '2 minutes'`)
    expect(await claim()).toHaveLength(0)
    await expect(db.as(alice, `select public.sender_unblock($1)`, [sender])).rejects.toThrow(/not_authorized/)
    await db.as(admin, `select public.sender_unblock($1)`, [sender])
    expect((await claim()).length).toBeGreaterThan(0)
  })

  it('an expired lease becomes unknown_outcome and is never retried automatically', async () => {
    await readyCampaign(1)
    const [r] = await claim(1, 1)
    await db.sql(`update public.campaign_recipients set lease_until = now() - interval '1 second'`)
    await db.sql(`update public.send_attempts set created_at = created_at - interval '2 minutes'`)
    expect(await claim()).toHaveLength(0)
    const [row] = await db.sql(`select state from public.campaign_recipients`)
    expect(row.state).toBe('unknown_outcome')
    expect(await claim()).toHaveLength(0)
    // A late result from the original worker may still resolve it.
    expect((await finish(r, 'accepted_by_smtp'))[0].finish_attempt).toBe(true)
  })

  it('operator can requeue an unknown outcome explicitly', async () => {
    await readyCampaign(2)
    const [r] = await claim(1)
    await finish(r, 'unknown_outcome', 'connection_lost_after_data')
    await expect(
      db.as(bob, `select public.recipient_resolve_unknown($1, 'requeue')`, [r.recipient_id]),
    ).rejects.toThrow(/not_authorized/)
    await db.as(alice, `select public.recipient_resolve_unknown($1, 'requeue')`, [r.recipient_id])
    const [row] = await db.sql(`select state from public.campaign_recipients where id = $1`, [r.recipient_id])
    expect(row.state).toBe('queued')
  })

  it('a finished lease cannot be reported twice', async () => {
    await readyCampaign(1)
    const [r] = await claim()
    await finish(r, 'permanent_failure', 'recipient_rejected')
    expect((await finish(r, 'accepted_by_smtp'))[0].finish_attempt).toBe(false)
  })

  it('test sends count against sender caps and a per-user quota', async () => {
    const [{ id }] = await db.as<{ id: string }>('service_role', `select public.reserve_test_send($1, $2) as id`, [sender, alice])
    expect(id).toBeTruthy()
    await db.as('service_role', `select public.reserve_test_send($1, $2)`, [sender, alice])
    await expect(db.as('service_role', `select public.reserve_test_send($1, $2)`, [sender, alice])).rejects.toThrow(/rate_limited/)
  })
})

describe('unsubscribe', () => {
  it('suppresses the address across campaigns via an unguessable token', async () => {
    const c1 = await newCampaign(alice)
    const c2 = await newCampaign(bob)
    await db.as(alice, `select public.campaign_set_recipients($1, $2::jsonb)`, [c1, JSON.stringify([{ email: 'x@example.com' }])])
    await db.as(bob, `select public.campaign_set_recipients($1, $2::jsonb)`, [c2, JSON.stringify([{ email: 'X@example.com' }])])
    const [{ unsubscribe_token }] = await db.sql(`select unsubscribe_token from public.campaign_recipients where campaign_id = $1`, [c1])
    expect(unsubscribe_token).toMatch(/^[0-9a-f]{64}$/)
    const bad = await db.as('service_role', `select public.unsubscribe_by_token($1) as ok`, ['0'.repeat(64)])
    expect(bad[0].ok).toBe(false)
    const ok = await db.as('service_role', `select public.unsubscribe_by_token($1) as ok`, [unsubscribe_token])
    expect(ok[0].ok).toBe(true)
    const states = await db.sql(`select state from public.campaign_recipients`)
    expect(states.every((s) => s.state === 'skipped_unsubscribed')).toBe(true)
  })
})

describe('audit', () => {
  it('records sender permission grants and setting changes with the acting admin', async () => {
    await db.as(admin, `insert into public.sender_permissions (user_id, sender_id, granted_by) values ($1, $2, $3)`, [alice, otherSender, admin])
    await db.as(admin, `update public.app_settings set sending_enabled = false where id = 1`)
    const logs = await db.sql(`select actor_id, action from public.audit_logs order by id`)
    expect(logs).toEqual(
      expect.arrayContaining([
        { actor_id: admin, action: 'sender_permissions.insert' },
        { actor_id: admin, action: 'app_settings.update' },
      ]),
    )
  })
})
