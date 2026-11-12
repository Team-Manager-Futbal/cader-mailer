import { type DealStage, dueState, formatDate, STAGE_LABELS, STAGE_TONES } from '../lib/crm'
import { Badge } from './ui'

export function StageBadge({ stage }: { stage: DealStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>
}

/** Next-step date, coloured by urgency (overdue / today / within a week). */
export function DueBadge({ date }: { date: string | null }) {
  const d = dueState(date)
  if (!d || !date) return <span className="text-stone-400">–</span>
  if (d === 'overdue') return <Badge tone="red">{formatDate(date)} · po termíne</Badge>
  if (d === 'today') return <Badge tone="amber">Dnes</Badge>
  if (d === 'soon') return <Badge tone="blue">{formatDate(date)}</Badge>
  return <Badge>{formatDate(date)}</Badge>
}
