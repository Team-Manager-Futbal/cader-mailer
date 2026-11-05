-- Cader Mailer: core schema.
-- All timestamps are timestamptz (stored in UTC). Display in Europe/Bratislava happens in the UI.

-- Only core PostgreSQL functions are used (gen_random_uuid is built in since PG13).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.user_role as enum ('admin', 'member');

create type public.campaign_status as enum (
  'draft', 'scheduled', 'processing', 'paused', 'completed', 'cancelled'
);

create type public.recipient_state as enum (
  'queued',
  'processing',
  'accepted_by_smtp',
  'temporary_failure',
  'permanent_failure',
  'skipped_unsubscribed',
  'cancelled',
  'unknown_outcome'
);

create type public.legal_basis as enum (
  'public_business_contact', 'consent', 'existing_customer', 'other_reviewed_basis'
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.normalize_email(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select lower(btrim(p)) $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user). Role lives here, never in user metadata.
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        public.user_role not null default 'member',
  -- Fail closed: a user is inactive until an admin invite (or bootstrap) activates them.
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (public.normalize_email(email));
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p where p.user_id = auth.uid() and p.active
  )
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.active and p.role = 'admin'
  )
$$;

-- ---------------------------------------------------------------------------
-- Global settings (singleton row id = 1)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  id                        smallint primary key default 1 check (id = 1),
  -- Global kill switch. Defaults to OFF: nothing is sent until an admin enables it.
  sending_enabled           boolean not null default false,
  -- Members may never schedule faster than this per-campaign rate (messages / minute).
  max_member_rate_per_minute integer not null default 2 check (max_member_rate_per_minute between 1 and 30),
  -- Public URL of the frontend, used for unsubscribe links, e.g. https://user.github.io/cader-mailer/
  frontend_url              text not null default '',
  -- Footer appended to every campaign message (sender identification + opt-out text).
  footer_text               text not null default E'--\nCader · https://caderapp.com\nAk si neželáte dostávať ďalšie správy, odhláste sa tu: {odhlasenie}',
  -- Addresses (besides a user''s own login e-mail) allowed to receive test messages.
  test_recipient_allowlist  text[] not null default '{}',
  updated_at                timestamptz not null default now()
);
insert into public.app_settings (id) values (1);
create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Sender accounts. SMTP secrets live in sender_secrets (never readable by clients).
-- ---------------------------------------------------------------------------
create table public.sender_accounts (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null,
  display_name         text not null default '',
  provider             text not null default 'seznam' check (provider in ('seznam', 'custom')),
  smtp_host            text not null default 'smtp.seznam.cz',
  smtp_port            integer not null default 465 check (smtp_port between 1 and 65535),
  -- true = implicit TLS (port 465). STARTTLS is not supported by the transport.
  smtp_tls             boolean not null default true,
  smtp_username        text not null default '',
  reply_to             text,
  active               boolean not null default false,
  rate_per_minute      integer not null default 2  check (rate_per_minute between 1 and 60),
  hourly_cap           integer not null default 60 check (hourly_cap between 1 and 2000),
  daily_cap            integer not null default 200 check (daily_cap between 1 and 10000),
  credential_set       boolean not null default false,
  last_test_at         timestamptz,
  last_test_ok         boolean,
  last_test_message    text,
  -- Set automatically when the provider signals a limit/block. No sends until cleared.
  blocked_until        timestamptz,
  blocked_reason       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint sender_email_format check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint sender_reply_to_format check (reply_to is null or reply_to ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
create unique index sender_accounts_email_key on public.sender_accounts (public.normalize_email(email));
create trigger sender_accounts_updated_at before update on public.sender_accounts
  for each row execute function public.set_updated_at();

create table public.sender_secrets (
  sender_id   uuid primary key references public.sender_accounts (id) on delete cascade,
  -- AES-256-GCM ciphertext and IV (base64), key is SENDER_SECRET_KEY in Edge Function secrets.
  ciphertext  text not null,
  iv          text not null,
  updated_at  timestamptz not null default now()
);

create table public.sender_permissions (
  user_id     uuid not null references public.profiles (user_id) on delete cascade,
  sender_id   uuid not null references public.sender_accounts (id) on delete cascade,
  granted_by  uuid references public.profiles (user_id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, sender_id)
);
create index sender_permissions_sender_idx on public.sender_permissions (sender_id);

create or replace function public.can_use_sender(p_sender uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or (
    public.is_active_user() and exists (
      select 1 from public.sender_permissions sp
      where sp.sender_id = p_sender and sp.user_id = auth.uid()
    )
  )
$$;

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------
create table public.templates (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (user_id) on delete cascade,
  name        text not null check (length(name) between 1 and 200),
  subject     text not null default '' check (length(subject) <= 500),
  body_text   text not null default '' check (length(body_text) <= 50000),
  shared      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger templates_updated_at before update on public.templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references public.profiles (user_id) on delete restrict,
  sender_id         uuid references public.sender_accounts (id) on delete restrict,
  name              text not null check (length(name) between 1 and 200),
  subject           text not null default '' check (length(subject) <= 500),
  body_text         text not null default '' check (length(body_text) <= 50000),
  status            public.campaign_status not null default 'draft',
  status_reason     text,
  scheduled_at      timestamptz,
  rate_per_minute   integer not null default 2 check (rate_per_minute between 1 and 60),
  legal_basis       public.legal_basis,
  legal_note        text check (length(legal_note) <= 2000),
  confirmed_at      timestamptz,
  confirmed_by      uuid references public.profiles (user_id) on delete set null,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint campaign_confirmed_requires_basis check (
    status in ('draft') or (legal_basis is not null and confirmed_at is not null and scheduled_at is not null and sender_id is not null)
  )
);
create index campaigns_owner_idx on public.campaigns (owner_id);
create index campaigns_status_idx on public.campaigns (status, scheduled_at);
create trigger campaigns_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();

create table public.campaign_recipients (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references public.campaigns (id) on delete cascade,
  email               text not null,
  email_normalized    text not null,
  meno                text not null default '',
  klub                text not null default '',
  pozicia             text not null default '',
  state               public.recipient_state not null default 'queued',
  attempts            integer not null default 0,
  next_attempt_at     timestamptz,
  lease_token         uuid,
  lease_until         timestamptz,
  last_attempt_at     timestamptz,
  accepted_at         timestamptz,
  smtp_message_id     text,
  last_error_category text,
  last_error          text,
  -- ~244-bit random token (two v4 UUIDs) for unsubscribe links. Never derived from ids.
  unsubscribe_token   text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint recipient_email_normalized check (email_normalized = public.normalize_email(email)),
  constraint recipient_email_format check (email_normalized ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
create unique index campaign_recipients_unique_email on public.campaign_recipients (campaign_id, email_normalized);
create index campaign_recipients_due_idx on public.campaign_recipients (campaign_id, state, next_attempt_at);
create index campaign_recipients_lease_idx on public.campaign_recipients (lease_until) where state = 'processing';
create index campaign_recipients_email_idx on public.campaign_recipients (email_normalized);
create trigger campaign_recipients_updated_at before update on public.campaign_recipients
  for each row execute function public.set_updated_at();

-- One row per SMTP attempt (campaign or test). Also the source of truth for per-sender caps.
create table public.send_attempts (
  id             bigint generated always as identity primary key,
  sender_id      uuid not null references public.sender_accounts (id) on delete cascade,
  recipient_id   uuid references public.campaign_recipients (id) on delete cascade,
  campaign_id    uuid references public.campaigns (id) on delete cascade,
  is_test        boolean not null default false,
  requested_by   uuid references public.profiles (user_id) on delete set null,
  attempt_no     integer not null default 1,
  outcome        text not null default 'in_progress' check (outcome in (
    'in_progress', 'accepted_by_smtp', 'temporary_failure', 'permanent_failure', 'unknown_outcome', 'skipped'
  )),
  smtp_code      integer,
  error_category text,
  error          text,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index send_attempts_sender_time_idx on public.send_attempts (sender_id, created_at desc);
create index send_attempts_recipient_idx on public.send_attempts (recipient_id);

-- Team-wide suppression list (opt-outs, objections, manual blocks).
create table public.suppression_list (
  email_normalized text primary key,
  reason           text not null default 'unsubscribe' check (reason in ('unsubscribe', 'manual', 'objection', 'bounce')),
  note             text check (length(note) <= 1000),
  created_by       uuid references public.profiles (user_id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint suppression_email_normalized check (email_normalized = public.normalize_email(email_normalized))
);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles (user_id) on delete set null,
  action      text not null,
  entity      text,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_time_idx on public.audit_logs (created_at desc);

create or replace function public.write_audit(p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb))
$$;
revoke all on function public.write_audit(text, text, text, jsonb) from public, anon, authenticated;
