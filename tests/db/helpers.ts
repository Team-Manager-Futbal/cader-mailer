import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

// Local disposable Postgres (see README "Testy"). Never point this at a real project.
export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@localhost:54329/postgres'

const root = join(import.meta.dirname, '..', '..')

export async function createTestDatabase(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`drop database if exists ${name} with (force)`)
  await admin.query(`create database ${name}`)
  await admin.end()

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`)
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  await db.query(readFileSync(join(root, 'tests/db/supabase-stub.sql'), 'utf8'))
  const dir = join(root, 'supabase/migrations')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(dir, file), 'utf8'))
  }
  await db.end()
  return url
}

export class Db {
  pool: pg.Pool
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 6 })
  }

  /** Run as superuser (test setup). */
  async sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
    return (await this.pool.query<T>(text, params)).rows
  }

  /** Run a statement the way PostgREST would for a given JWT subject (or anon / service_role). */
  async as<T extends pg.QueryResultRow = pg.QueryResultRow>(
    who: string | 'anon' | 'service_role',
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      if (who === 'anon') {
        await client.query('set local role anon')
      } else if (who === 'service_role') {
        await client.query('set local role service_role')
      } else {
        await client.query('set local role authenticated')
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who])
      }
      const res = await client.query<T>(text, params)
      await client.query('commit')
      return res.rows
    } catch (e) {
      await client.query('rollback')
      throw e
    } finally {
      client.release()
    }
  }

  /** Opens a transaction as service_role and leaves it open (to simulate a slow concurrent worker). */
  async openServiceTx() {
    const client = await this.pool.connect()
    await client.query('begin')
    await client.query('set local role service_role')
    return {
      query: <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) =>
        client.query<T>(text, params).then((r) => r.rows),
      commit: async () => {
        await client.query('commit')
        client.release()
      },
    }
  }

  async createUser(email: string, opts: { role?: 'admin' | 'member'; active?: boolean } = {}) {
    const [u] = await this.sql<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [email])
    await this.sql(`update public.profiles set role = $2, active = $3 where user_id = $1`, [
      u.id,
      opts.role ?? 'member',
      opts.active ?? true,
    ])
    return u.id
  }

  async createSender(email: string, opts: { ready?: boolean; rate?: number; hourly?: number; daily?: number } = {}) {
    const ready = opts.ready ?? true
    const [s] = await this.sql<{ id: string }>(
      `insert into public.sender_accounts (email, display_name, smtp_username, active, credential_set, last_test_ok,
         rate_per_minute, hourly_cap, daily_cap)
       values ($1, 'Test', $1, $2, $2, $3, $4, $5, $6) returning id`,
      [email, ready, ready ? true : null, opts.rate ?? 2, opts.hourly ?? 60, opts.daily ?? 200],
    )
    return s.id
  }

  async close() {
    await this.pool.end()
  }
}
