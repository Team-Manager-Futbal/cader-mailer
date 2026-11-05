import type { ReactNode } from 'react'
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Alert, Loading } from './components/ui'
import { useAuth } from './lib/auth'
import { configured } from './lib/supabase'
import { AccountPage } from './pages/AccountPage'
import { CampaignDetailPage } from './pages/CampaignDetailPage'
import { CampaignEditorPage } from './pages/CampaignEditorPage'
import { CampaignsPage } from './pages/CampaignsPage'
import { ContactsPage } from './pages/ContactsPage'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { SendersPage } from './pages/SendersPage'
import { SetPasswordPage } from './pages/SetPasswordPage'
import { SettingsPage } from './pages/SettingsPage'
import { TemplatesPage } from './pages/TemplatesPage'
import { UnsubscribePage } from './pages/UnsubscribePage'
import { UsersPage } from './pages/UsersPage'

function Protected({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { loading, session, profile, needsPassword } = useAuth()
  if (loading) return <Loading />
  if (!session) return <LoginPage />
  if (needsPassword) return <SetPasswordPage />
  if (!profile) return <Loading label="Načítava sa profil…" />
  if (!profile.active) {
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert tone="warning" title="Účet nie je aktívny">
          Váš účet zatiaľ nebol aktivovaný alebo bol deaktivovaný. Kontaktujte administrátora.
        </Alert>
      </div>
    )
  }
  if (admin && profile.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}

const router = createHashRouter([
  // Public opt-out confirmation (no login).
  { path: '/odhlasenie', element: <UnsubscribePage /> },
  {
    path: '/',
    element: (
      <Protected>
        <Layout />
      </Protected>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'kampane', element: <CampaignsPage /> },
      { path: 'kampane/nova', element: <CampaignEditorPage /> },
      { path: 'kampane/:id', element: <CampaignDetailPage /> },
      { path: 'kampane/:id/upravit', element: <CampaignEditorPage /> },
      { path: 'sablony', element: <TemplatesPage /> },
      { path: 'kontakty', element: <ContactsPage /> },
      { path: 'ucet', element: <AccountPage /> },
      { path: 'pouzivatelia', element: <Protected admin><UsersPage /></Protected> },
      { path: 'odosielatelia', element: <Protected admin><SendersPage /></Protected> },
      { path: 'nastavenia', element: <Protected admin><SettingsPage /></Protected> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])

export default function App() {
  if (!configured) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert tone="error" title="Aplikácia nie je nakonfigurovaná">
          Chýba VITE_SUPABASE_URL alebo VITE_SUPABASE_PUBLISHABLE_KEY. Pozrite README, časť „Nasadenie na GitHub Pages“.
        </Alert>
      </div>
    )
  }
  return <RouterProvider router={router} />
}
