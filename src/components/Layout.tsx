import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { cx } from './ui'

const NAV = [
  { to: '/', label: 'Prehľad', end: true },
  { to: '/kampane', label: 'Kampane', end: true },
  { to: '/kampane/nova', label: 'Nová kampaň' },
  { to: '/sablony', label: 'Šablóny' },
  { to: '/kontakty', label: 'Kontakty' },
]
const ADMIN_NAV = [
  { to: '/pouzivatelia', label: 'Používatelia' },
  { to: '/odosielatelia', label: 'Odosielatelia' },
  { to: '/nastavenia', label: 'Nastavenia' },
]

function Item({ to, label, end, onClick }: { to: string; label: string; end?: boolean; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        cx(
          'block rounded-md px-3 py-2 text-sm font-medium',
          isActive ? 'bg-brand-800 text-white' : 'text-stone-700 hover:bg-stone-200/70',
        )
      }
    >
      {label}
    </NavLink>
  )
}

export function Layout() {
  const { profile, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const nav = (
    <nav aria-label="Hlavná navigácia" className="space-y-1">
      {NAV.map((n) => (
        <Item key={n.to} {...n} onClick={close} />
      ))}
      {profile?.role === 'admin' && (
        <>
          <p className="px-3 pt-5 pb-1 text-xs font-semibold tracking-wide text-stone-500 uppercase">Administrácia</p>
          {ADMIN_NAV.map((n) => (
            <Item key={n.to} {...n} onClick={close} />
          ))}
        </>
      )}
    </nav>
  )
  return (
    <div className="min-h-screen lg:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Preskočiť na obsah
      </a>
      <aside className="hidden w-60 shrink-0 flex-col self-start border-r border-stone-200 bg-stone-100/60 px-3 py-5 lg:sticky lg:top-0 lg:flex lg:h-screen lg:overflow-y-auto">
        <Brand />
        <div className="mt-6 flex-1">{nav}</div>
        <UserBox name={profile?.full_name || profile?.email || ''} role={profile?.role} onSignOut={signOut} />
      </aside>

      <header className="flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3 lg:hidden">
        <Brand />
        <button
          type="button"
          className="rounded-md px-3 py-2 text-sm font-medium ring-1 ring-stone-300"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((o) => !o)}
        >
          Menu
        </button>
      </header>
      {open && (
        <div id="mobile-nav" className="border-b border-stone-200 bg-white px-3 py-3 lg:hidden">
          {nav}
          <div className="mt-4 border-t border-stone-200 pt-3">
            <UserBox name={profile?.full_name || profile?.email || ''} role={profile?.role} onSignOut={signOut} onNavigate={close} />
          </div>
        </div>
      )}

      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <span className="grid size-8 place-items-center rounded-md bg-brand-800 text-white" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M3 7l9 6 9-6M3 7v11h18V7" />
        </svg>
      </span>
      <span className="font-semibold tracking-tight">Cader Mailer</span>
    </div>
  )
}

function UserBox({ name, role, onSignOut, onNavigate }: { name: string; role?: string; onSignOut: () => void; onNavigate?: () => void }) {
  return (
    <div className="space-y-2 px-2 text-sm">
      <div>
        <p className="truncate font-medium">{name}</p>
        <p className="text-xs text-stone-500">{role === 'admin' ? 'Administrátor' : 'Člen tímu'}</p>
      </div>
      <div className="flex gap-3">
        <NavLink to="/ucet" onClick={onNavigate} className="text-stone-700 underline-offset-2 hover:underline">
          Môj účet
        </NavLink>
        <button type="button" onClick={onSignOut} className="text-stone-700 underline-offset-2 hover:underline">
          Odhlásiť sa
        </button>
      </div>
    </div>
  )
}
