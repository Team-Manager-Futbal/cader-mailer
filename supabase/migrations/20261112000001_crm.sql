-- Cader Mailer: lightweight sales CRM (clubs and partners, people, activity history, next steps).
-- Shared by the whole active team. Accounts are created automatically from campaign e-mails
-- accepted by SMTP, so every club that was written to shows up in the pipeline.

create type public.account_type as enum ('club', 'partner');
create type public.deal_stage as enum (
  'new', 'contacted', 'replied', 'meeting', 'proposal', 'client', 'not_interested', 'postponed'
);
create type public.activity_kind as enum ('note', 'call', 'email', 'meeting', 'stage_change', 'campaign');

create table public.accounts (
  id                uuid primary key default gen_random_uuid(),
  type              public.account_type not null default 'club',
  name              text not null check (length(btrim(name)) between 1 and 200),
  name_key          text generated always as (lower(btrim(name))) stored,
  stage             public.deal_stage not null default 'new',
  stage_changed_at  timestamptz not null default now(),
  owner_id          uuid references public.profiles (user_id) on delete set null,
  next_action_on    date,
  next_action_note  text check (length(next_action_note) <= 500),
  -- Agreed meeting details / commercial terms, free text.
  terms             text check (length(terms) <= 5000),
  website           text check (length(website) <= 300),
  region            text check (length(region) <= 200),
  created_by        uuid references public.profiles (user_id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index accounts_type_name_key on public.accounts (type, name_key);
create index accounts_next_action_idx on public.accounts (next_action_on) where next_action_on is not null;
create index accounts_stage_idx on public.accounts (stage);
create trigger accounts_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

create table public.account_contacts (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts (id) on delete cascade,
  full_name         text not null default '' check (length(full_name) <= 200),
  role              text not null default '' check (length(role) <= 200),
  email             text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  email_normalized  text generated always as (lower(btrim(email))) stored,
  phone             text not null default '' check (length(phone) <= 50),
  note              text check (length(note) <= 1000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index account_contacts_email_key on public.account_contacts (account_id, email_normalized)
  where email_normalized is not null;
create index account_contacts_email_idx on public.account_contacts (email_normalized);
create trigger account_contacts_updated_at before update on public.account_contacts
  for each row execute function public.set_updated_at();

create table public.account_activities (
  id           bigint generated always as identity primary key,
  account_id   uuid not null references public.accounts (id) on delete cascade,
  author_id    uuid references public.profiles (user_id) on delete set null,
  kind         public.activity_kind not null,
  body         text not null default '' check (length(body) <= 10000),
  happened_at  timestamptz not null default now(),
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index account_activities_account_idx on public.account_activities (account_id, happened_at desc);

-- ---------------------------------------------------------------------------
-- Stage changes are recorded in the history automatically.
-- ---------------------------------------------------------------------------
create or replace function public.accounts_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_changed_at := now();
    insert into public.account_activities (account_id, author_id, kind, meta)
    values (new.id, auth.uid(), 'stage_change', jsonb_build_object('from', old.stage, 'to', new.stage));
  end if;
  return new;
end $$;
create trigger accounts_stage_change before update on public.accounts
  for each row execute function public.accounts_stage_change();

-- ---------------------------------------------------------------------------
-- Campaign e-mails -> CRM. Called for every recipient accepted by SMTP.
-- Finds the account through an existing contact with the same address, otherwise by club
-- name (falls back to the address when the import had no club), and records the e-mail.
-- ---------------------------------------------------------------------------
create or replace function public.crm_link_recipient(p_recipient uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.campaign_recipients;
  v_campaign text;
  v_owner uuid;
  v_account uuid;
  v_name text;
begin
  select * into v_r from public.campaign_recipients where id = p_recipient;
  if not found or v_r.state <> 'accepted_by_smtp' then return; end if;
  select name, owner_id into v_campaign, v_owner from public.campaigns where id = v_r.campaign_id;

  -- Already recorded for this recipient (idempotent).
  if exists (select 1 from public.account_activities a
              where a.kind = 'campaign' and a.meta ->> 'recipient_id' = p_recipient::text) then
    return;
  end if;

  select c.account_id into v_account from public.account_contacts c
   where c.email_normalized = v_r.email_normalized
   order by c.created_at limit 1;

  if v_account is null then
    v_name := left(coalesce(nullif(btrim(v_r.klub), ''), v_r.email_normalized), 200);
    insert into public.accounts (type, name, stage, owner_id, created_by)
    values ('club', v_name, 'contacted', v_owner, v_owner)
    on conflict (type, name_key) do nothing
    returning id into v_account;
    if v_account is null then
      select id into v_account from public.accounts where type = 'club' and name_key = lower(btrim(v_name));
    end if;
    insert into public.account_contacts (account_id, full_name, role, email)
    values (v_account, left(v_r.meno, 200), left(v_r.pozicia, 200), v_r.email)
    on conflict (account_id, email_normalized) where email_normalized is not null do nothing;
  end if;

  update public.accounts set stage = 'contacted' where id = v_account and stage = 'new';

  insert into public.account_activities (account_id, author_id, kind, body, happened_at, meta)
  values (v_account, v_owner, 'campaign', 'E-mail z kampane „' || coalesce(v_campaign, '') || '“',
          coalesce(v_r.accepted_at, now()),
          jsonb_build_object('campaign_id', v_r.campaign_id, 'recipient_id', v_r.id, 'email', v_r.email_normalized));
end $$;

create or replace function public.campaign_recipients_to_crm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'accepted_by_smtp' and old.state is distinct from 'accepted_by_smtp' then
    -- The CRM must never break the send queue: a failure here is logged and skipped.
    begin
      perform public.crm_link_recipient(new.id);
    exception when others then
      raise warning 'crm_link_recipient failed for %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end $$;
create trigger campaign_recipients_to_crm after update of state on public.campaign_recipients
  for each row execute function public.campaign_recipients_to_crm();

-- Backfill: everything already accepted before this migration.
do $$
declare r record;
begin
  for r in select id from public.campaign_recipients where state = 'accepted_by_smtp' order by accepted_at, id loop
    perform public.crm_link_recipient(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: the CRM is shared by all active team members.
-- ---------------------------------------------------------------------------
alter table public.accounts           enable row level security;
alter table public.account_contacts   enable row level security;
alter table public.account_activities enable row level security;

revoke all on public.accounts, public.account_contacts, public.account_activities from anon, authenticated;
revoke all on sequence public.account_activities_id_seq from anon, authenticated;

grant select, delete on public.accounts to authenticated;
grant insert (type, name, stage, owner_id, next_action_on, next_action_note, terms, website, region, created_by)
  on public.accounts to authenticated;
grant update (type, name, stage, owner_id, next_action_on, next_action_note, terms, website, region)
  on public.accounts to authenticated;
create policy accounts_select on public.accounts for select to authenticated using (public.is_active_user());
create policy accounts_insert on public.accounts for insert to authenticated
  with check (public.is_active_user() and created_by = auth.uid());
create policy accounts_update on public.accounts for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
create policy accounts_delete on public.accounts for delete to authenticated using (public.is_admin());

grant select, insert, update, delete on public.account_contacts to authenticated;
create policy contacts_select on public.account_contacts for select to authenticated using (public.is_active_user());
create policy contacts_insert on public.account_contacts for insert to authenticated with check (public.is_active_user());
create policy contacts_update on public.account_contacts for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());
create policy contacts_delete on public.account_contacts for delete to authenticated using (public.is_active_user());

grant select, delete on public.account_activities to authenticated;
grant insert (account_id, author_id, kind, body, happened_at) on public.account_activities to authenticated;
grant usage on sequence public.account_activities_id_seq to authenticated;
create policy activities_select on public.account_activities for select to authenticated using (public.is_active_user());
-- People log notes/calls/e-mails/meetings as themselves; stage and campaign entries are system-generated.
create policy activities_insert on public.account_activities for insert to authenticated
  with check (public.is_active_user() and author_id = auth.uid() and kind in ('note', 'call', 'email', 'meeting'));
create policy activities_delete on public.account_activities for delete to authenticated
  using (public.is_active_user() and kind in ('note', 'call', 'email', 'meeting')
         and (author_id = auth.uid() or public.is_admin()));

revoke execute on function public.crm_link_recipient(uuid), public.campaign_recipients_to_crm(),
  public.accounts_stage_change() from public, anon, authenticated;
