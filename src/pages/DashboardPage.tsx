import { Link } from 'react-router-dom'
import { CampaignTable } from '../components/CampaignTable'
import { Alert, Button, Card, Loading, PageHeader, Stat } from '../components/ui'
import { useAuth } from '../lib/auth'
import { loadOverview, loadSettings, useLoad } from '../lib/data'
import { STATUS_LABELS, type CampaignStatus } from '../lib/types'

const ORDER: CampaignStatus[] = ['draft', 'scheduled', 'processing', 'paused', 'completed', 'cancelled']

export function DashboardPage() {
  const { profile } = useAuth()
  const overview = useLoad(loadOverview)
  const settings = useLoad(loadSettings)
  const isAdmin = profile?.role === 'admin'

  return (
    <>
      <PageHeader
        title="Prehľad"
        description={isAdmin ? 'Všetky kampane tímu.' : 'Vaše kampane.'}
        actions={
          <>
            <Button onClick={() => overview.reload()} busy={overview.loading}>
              Obnoviť
            </Button>
            <Link to="/kampane/nova" className="inline-flex items-center rounded-md bg-brand-800 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-900">
              Nová kampaň
            </Link>
          </>
        }
      />
      {settings.data && !settings.data.sending_enabled && (
        <div className="mb-6">
          <Alert tone="warning" title="Odosielanie je globálne vypnuté">
            Naplánované kampane sa nespustia, kým administrátor nezapne odosielanie v Nastaveniach.
          </Alert>
        </div>
      )}
      {overview.error && <Alert tone="error">{overview.error}</Alert>}
      {!overview.data && overview.loading && <Loading />}
      {overview.data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {ORDER.map((st) => (
              <Stat key={st} label={STATUS_LABELS[st]} value={overview.data!.campaigns.filter((c) => c.status === st).length} />
            ))}
          </div>
          <Card title="Posledné kampane">
            <CampaignTable overview={overview.data} campaigns={overview.data.campaigns.slice(0, 15)} showOwner={isAdmin} />
          </Card>
          <p className="mt-3 text-xs text-stone-500">
            „Prijaté SMTP“ znamená, že správu prijal odchádzajúci server poskytovateľa. Nie je to potvrdenie doručenia do schránky príjemcu.
          </p>
        </>
      )}
    </>
  )
}
