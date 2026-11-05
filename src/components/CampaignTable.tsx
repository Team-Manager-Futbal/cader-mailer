import { Link } from 'react-router-dom'
import type { CampaignOverview } from '../lib/data'
import { senderLabel } from '../lib/data'
import { formatLocal } from '../lib/time'
import type { Campaign } from '../lib/types'
import { Empty, StatusBadge, TableWrap, Td, Th } from './ui'

export function CampaignTable({ overview, campaigns, showOwner }: { overview: CampaignOverview; campaigns: Campaign[]; showOwner: boolean }) {
  if (campaigns.length === 0) {
    return (
      <Empty title="Zatiaľ tu nie sú žiadne kampane">
        <Link to="/kampane/nova" className="font-medium text-brand-800 underline">
          Vytvoriť novú kampaň
        </Link>
      </Empty>
    )
  }
  return (
    <TableWrap>
      <thead className="bg-stone-50">
        <tr>
          <Th>Kampaň</Th>
          <Th>Stav</Th>
          <Th>Odosielateľ</Th>
          <Th>Začiatok</Th>
          {showOwner && <Th>Vytvoril</Th>}
          <Th className="text-right">Príjemcovia</Th>
          <Th className="text-right">
            <abbr title="Prijaté SMTP serverom – neznamená potvrdené doručenie do schránky">Prijaté SMTP</abbr>
          </Th>
          <Th className="text-right">Zlyhané</Th>
          <Th className="text-right">Preskočené</Th>
          <Th className="text-right">Čaká</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {campaigns.map((c) => {
          const s = overview.stats.get(c.id)
          const owner = overview.profiles.get(c.owner_id)
          return (
            <tr key={c.id} className="hover:bg-stone-50">
              <Td>
                <Link to={`/kampane/${c.id}`} className="font-medium text-stone-900 underline-offset-2 hover:underline">
                  {c.name}
                </Link>
                {(s?.unknown ?? 0) > 0 && <p className="mt-0.5 text-xs font-medium text-amber-700">{s?.unknown} na kontrolu</p>}
              </Td>
              <Td>
                <StatusBadge status={c.status} />
              </Td>
              <Td className="max-w-48 truncate">{senderLabel(c.sender_id ? overview.senders.get(c.sender_id) : undefined)}</Td>
              <Td className="whitespace-nowrap">{formatLocal(c.started_at ?? c.scheduled_at)}</Td>
              {showOwner && <Td className="whitespace-nowrap">{owner?.full_name || owner?.email || '–'}</Td>}
              <Td className="text-right tabular-nums">{s?.total ?? 0}</Td>
              <Td className="text-right tabular-nums">{s?.accepted ?? 0}</Td>
              <Td className="text-right tabular-nums">{s?.failed ?? 0}</Td>
              <Td className="text-right tabular-nums">{(s?.skipped ?? 0) + (s?.cancelled ?? 0)}</Td>
              <Td className="text-right tabular-nums">{(s?.queued ?? 0) + (s?.processing ?? 0)}</Td>
            </tr>
          )
        })}
      </tbody>
    </TableWrap>
  )
}
