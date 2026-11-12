import { Link } from 'react-router-dom'
import { type Account, STAGE_LABELS, type DealStage, todayLocal } from '../lib/crm'
import { must, useLoad } from '../lib/data'
import { supabase } from '../lib/supabase'
import { DueBadge, StageBadge } from './crm'
import { Alert, Card, Stat } from './ui'

const PIPELINE: DealStage[] = ['contacted', 'replied', 'meeting', 'proposal', 'client']

/** Dashboard block: next steps due (overdue, today, next 7 days) and pipeline counts. */
export function FollowUps() {
  const data = useLoad(async () => {
    const d = new Date(`${todayLocal()}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 7)
    const [due, all] = await Promise.all([
      must(
        supabase
          .from('accounts')
          .select('id, name, stage, next_action_on, next_action_note')
          .not('next_action_on', 'is', null)
          .lte('next_action_on', d.toISOString().slice(0, 10))
          .order('next_action_on')
          .limit(50),
      ),
      must(supabase.from('accounts').select('stage')),
    ])
    const counts = new Map<DealStage, number>()
    for (const r of all as { stage: DealStage }[]) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1)
    return { due: due as Pick<Account, 'id' | 'name' | 'stage' | 'next_action_on' | 'next_action_note'>[], counts }
  })

  if (data.error) return <Alert tone="error">{data.error}</Alert>
  if (!data.data) return null
  const { due, counts } = data.data
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {PIPELINE.map((s) => (
          <Stat key={s} label={STAGE_LABELS[s]} value={counts.get(s) ?? 0} />
        ))}
      </div>
      <Card
        title="Ozvať sa"
        actions={
          <Link to="/kluby" className="text-sm font-medium text-brand-800 underline-offset-2 hover:underline">
            Všetky kluby a partneri
          </Link>
        }
      >
        {due.length === 0 ? (
          <p className="text-sm text-stone-600">Na najbližších 7 dní nie je naplánovaný žiadny krok. Termín si nastavíte v detaile klubu („Ďalší krok“).</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {due.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <span className="w-40 shrink-0">
                  <DueBadge date={a.next_action_on} />
                </span>
                <Link to={`/kluby/${a.id}`} className="font-medium underline-offset-2 hover:underline">
                  {a.name}
                </Link>
                <StageBadge stage={a.stage} />
                {a.next_action_note && <span className="text-sm text-stone-600">{a.next_action_note}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
