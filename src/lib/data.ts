import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { dbError, supabase } from './supabase'
import type { AppSettings, Campaign, CampaignStats, Profile, SenderAccount } from './types'

export interface Loadable<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

/** Small fetch hook: runs `fn` on mount and whenever `reload` is called. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): Loadable<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  useLayoutEffect(() => {
    fnRef.current = fn
  })
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fnRef.current())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Načítanie zlyhalo.')
    } finally {
      setLoading(false)
    }
  }, [])
  const key = JSON.stringify(deps)
  useEffect(() => {
    reload()
  }, [reload, key])
  return { data, error, loading, reload }
}

export async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(dbError(error))
  return data as T
}

export interface CampaignOverview {
  campaigns: Campaign[]
  stats: Map<string, CampaignStats>
  senders: Map<string, SenderAccount>
  profiles: Map<string, Profile>
}

export async function loadOverview(): Promise<CampaignOverview> {
  const [campaigns, stats, senders, profiles] = await Promise.all([
    must(supabase.from('campaigns').select('*').order('created_at', { ascending: false }).limit(500)),
    must(supabase.rpc('campaign_stats')),
    must(supabase.from('sender_accounts').select('*')),
    must(supabase.from('profiles').select('*')),
  ])
  return {
    campaigns: campaigns as Campaign[],
    stats: new Map((stats as CampaignStats[]).map((s) => [s.campaign_id, s])),
    senders: new Map((senders as SenderAccount[]).map((s) => [s.id, s])),
    profiles: new Map((profiles as Profile[]).map((p) => [p.user_id, p])),
  }
}

export async function loadSettings(): Promise<AppSettings> {
  return must(supabase.from('app_settings').select('*').eq('id', 1).single()) as Promise<AppSettings>
}

/** Senders the current user may use (RLS already filters to assigned ones). */
export async function loadMySenders(): Promise<SenderAccount[]> {
  return must(supabase.from('sender_accounts').select('*').order('email')) as Promise<SenderAccount[]>
}

export function senderReady(s: SenderAccount): boolean {
  return s.active && s.credential_set && s.last_test_ok === true && !(s.blocked_until && new Date(s.blocked_until) > new Date())
}

export function senderLabel(s: SenderAccount | undefined): string {
  if (!s) return '–'
  return s.display_name ? `${s.display_name} <${s.email}>` : s.email
}
