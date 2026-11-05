export type Role = 'admin' | 'member'
export type CampaignStatus = 'draft' | 'scheduled' | 'processing' | 'paused' | 'completed' | 'cancelled'
export type RecipientState =
  | 'queued'
  | 'processing'
  | 'accepted_by_smtp'
  | 'temporary_failure'
  | 'permanent_failure'
  | 'skipped_unsubscribed'
  | 'cancelled'
  | 'unknown_outcome'
export type LegalBasis = 'public_business_contact' | 'consent' | 'existing_customer' | 'other_reviewed_basis'

export interface Profile {
  user_id: string
  email: string
  full_name: string
  role: Role
  active: boolean
  created_at: string
}

export interface AppSettings {
  sending_enabled: boolean
  max_member_rate_per_minute: number
  frontend_url: string
  footer_text: string
  test_recipient_allowlist: string[]
  updated_at: string
}

export interface SenderAccount {
  id: string
  email: string
  display_name: string
  provider: 'seznam' | 'custom'
  smtp_host: string
  smtp_port: number
  smtp_tls: boolean
  smtp_username: string
  reply_to: string | null
  active: boolean
  rate_per_minute: number
  hourly_cap: number
  daily_cap: number
  credential_set: boolean
  last_test_at: string | null
  last_test_ok: boolean | null
  last_test_message: string | null
  blocked_until: string | null
  blocked_reason: string | null
  created_at: string
}

export interface Campaign {
  id: string
  owner_id: string
  sender_id: string | null
  name: string
  subject: string
  body_text: string
  status: CampaignStatus
  status_reason: string | null
  scheduled_at: string | null
  rate_per_minute: number
  legal_basis: LegalBasis | null
  legal_note: string | null
  confirmed_at: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface Recipient {
  id: string
  campaign_id: string
  email: string
  email_normalized: string
  meno: string
  klub: string
  pozicia: string
  state: RecipientState
  attempts: number
  next_attempt_at: string | null
  last_attempt_at: string | null
  accepted_at: string | null
  last_error_category: string | null
  last_error: string | null
}

export interface CampaignStats {
  campaign_id: string
  total: number
  queued: number
  processing: number
  accepted: number
  failed: number
  skipped: number
  cancelled: number
  unknown: number
}

export interface Template {
  id: string
  owner_id: string
  name: string
  subject: string
  body_text: string
  shared: boolean
  updated_at: string
}

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Koncept',
  scheduled: 'Naplánovaná',
  processing: 'Odosiela sa',
  paused: 'Pozastavená',
  completed: 'Dokončená',
  cancelled: 'Zrušená',
}

export const RECIPIENT_LABELS: Record<RecipientState, string> = {
  queued: 'Čaká vo fronte',
  processing: 'Práve sa odosiela',
  accepted_by_smtp: 'Prijaté SMTP serverom',
  temporary_failure: 'Dočasná chyba',
  permanent_failure: 'Zlyhalo',
  skipped_unsubscribed: 'Preskočené (odhlásený)',
  cancelled: 'Zrušené',
  unknown_outcome: 'Neistý výsledok – skontrolovať',
}

export const LEGAL_BASIS_LABELS: Record<LegalBasis, string> = {
  public_business_contact: 'Verejne zverejnený firemný kontakt',
  consent: 'Súhlas príjemcu',
  existing_customer: 'Existujúci zákazník / obchodný vzťah',
  other_reviewed_basis: 'Iný preverený právny základ',
}
