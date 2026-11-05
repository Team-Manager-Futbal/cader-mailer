import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CampaignTable } from '../components/CampaignTable'
import { Alert, Button, Card, Input, Loading, PageHeader, Select } from '../components/ui'
import { useIsAdmin } from '../lib/auth'
import { loadOverview, useLoad } from '../lib/data'
import { STATUS_LABELS, type CampaignStatus } from '../lib/types'

export function CampaignsPage() {
  const isAdmin = useIsAdmin()
  const overview = useLoad(loadOverview)
  const [status, setStatus] = useState<CampaignStatus | ''>('')
  const [q, setQ] = useState('')
  const filtered = useMemo(
    () =>
      (overview.data?.campaigns ?? []).filter(
        (c) => (!status || c.status === status) && (!q || c.name.toLowerCase().includes(q.toLowerCase())),
      ),
    [overview.data, status, q],
  )
  return (
    <>
      <PageHeader
        title="Kampane"
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
      {overview.error && <Alert tone="error">{overview.error}</Alert>}
      {!overview.data && overview.loading && <Loading />}
      {overview.data && (
        <Card
          title={`${filtered.length} kampaní`}
          actions={
            <>
              <Input aria-label="Hľadať podľa názvu" placeholder="Hľadať…" value={q} onChange={(e) => setQ(e.target.value)} className="w-44" />
              <Select aria-label="Filtrovať podľa stavu" value={status} onChange={(e) => setStatus(e.target.value as CampaignStatus | '')} className="w-44">
                <option value="">Všetky stavy</option>
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </>
          }
        >
          <CampaignTable overview={overview.data} campaigns={filtered} showOwner={isAdmin} />
        </Card>
      )}
    </>
  )
}
