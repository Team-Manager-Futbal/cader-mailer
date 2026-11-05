import type { Session } from '@supabase/supabase-js'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Profile } from './types'

interface AuthState {
  loading: boolean
  session: Session | null
  profile: Profile | null
  /** Set after an invite or password-recovery link: the user must choose a password. */
  needsPassword: boolean
  clearNeedsPassword: () => void
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

// Read the auth link type before supabase-js consumes and clears the URL hash.
const initialHash = typeof window !== 'undefined' ? window.location.hash : ''
const linkType = /type=(invite|recovery|signup)/.exec(initialHash)?.[1]

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [needsPassword, setNeedsPassword] = useState(Boolean(linkType))

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null)
      return
    }
    const { data } = await supabase.from('profiles').select('*').eq('user_id', s.user.id).maybeSingle()
    setProfile((data as Profile) ?? null)
  }, [])

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return
      setSession(data.session)
      await loadProfile(data.session)
      setLoading(false)
      if (linkType && window.location.hash.includes('access_token')) window.location.hash = '#/'
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword(true)
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Defer DB calls out of the auth callback (supabase-js recommendation).
        setTimeout(() => loadProfile(s), 0)
      }
    })
    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [loadProfile])

  const value: AuthState = {
    loading,
    session,
    profile,
    needsPassword,
    clearNeedsPassword: () => setNeedsPassword(false),
    refreshProfile: () => loadProfile(session),
    signOut: async () => {
      await supabase.auth.signOut()
      setProfile(null)
      setSession(null)
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}

export function useIsAdmin(): boolean {
  return useAuth().profile?.role === 'admin'
}
