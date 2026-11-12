import { localInputs } from './time'

export type AccountType = 'club' | 'partner'
export type DealStage = 'new' | 'contacted' | 'replied' | 'meeting' | 'proposal' | 'client' | 'not_interested' | 'postponed'
export type ActivityKind = 'note' | 'call' | 'email' | 'meeting' | 'stage_change' | 'campaign'

export interface Account {
  id: string
  type: AccountType
  name: string
  stage: DealStage
  stage_changed_at: string
  owner_id: string | null
  next_action_on: string | null
  next_action_note: string | null
  terms: string | null
  website: string | null
  region: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AccountContact {
  id: string
  account_id: string
  full_name: string
  role: string
  email: string | null
  email_normalized: string | null
  phone: string
  note: string | null
}

export interface Activity {
  id: number
  account_id: string
  author_id: string | null
  kind: ActivityKind
  body: string
  happened_at: string
  meta: Record<string, unknown>
}

export const STAGES: DealStage[] = ['new', 'contacted', 'replied', 'meeting', 'proposal', 'client', 'postponed', 'not_interested']

export const STAGE_LABELS: Record<DealStage, string> = {
  new: 'Neoslovený',
  contacted: 'Oslovený',
  replied: 'Odpovedal',
  meeting: 'Stretnutie dohodnuté',
  proposal: 'Podmienky / ponuka',
  client: 'Klient',
  not_interested: 'Nemá záujem',
  postponed: 'Odložené',
}

export const STAGE_TONES: Record<DealStage, 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet'> = {
  new: 'neutral',
  contacted: 'blue',
  replied: 'violet',
  meeting: 'amber',
  proposal: 'amber',
  client: 'green',
  not_interested: 'red',
  postponed: 'neutral',
}

/** Stages in which a club should not get another bulk e-mail by default. */
export const DO_NOT_MAIL_STAGES: DealStage[] = ['replied', 'meeting', 'proposal', 'client', 'not_interested']

export const TYPE_LABELS: Record<AccountType, string> = { club: 'Klub', partner: 'Partner / sponzor' }

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  note: 'Poznámka',
  call: 'Telefonát',
  email: 'E-mail',
  meeting: 'Stretnutie',
  stage_change: 'Zmena stavu',
  campaign: 'Kampaň',
}

export const MANUAL_KINDS: ActivityKind[] = ['note', 'call', 'email', 'meeting']

/** Today's date in Bratislava as YYYY-MM-DD. */
export function todayLocal(): string {
  return localInputs(new Date()).date
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | null

export function dueState(date: string | null, today = todayLocal()): DueState {
  if (!date) return null
  if (date < today) return 'overdue'
  if (date === today) return 'today'
  const diff = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
  return diff <= 7 ? 'soon' : 'later'
}

export function formatDate(date: string | null): string {
  if (!date) return '–'
  const [y, m, d] = date.split('-').map(Number)
  return `${d}. ${m}. ${y}`
}
