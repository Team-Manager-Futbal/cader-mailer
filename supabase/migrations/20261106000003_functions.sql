-- Cader Mailer: RPCs for the UI (authenticated) and the queue worker (service_role only).
-- Every SECURITY DEFINER function pins search_path and re-checks identity/permissions itself.

-- ===========================================================================
-- Profile management
-- ===========================================================================
create or replace function public.update_my_name(p_full_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_active_user() then raise exception 'not_authorized' using errcode = '42501'; end if;
  update public.profiles set full_name = left(btrim(coalesce(p_full_name, '')), 200) where user_id = auth.uid();
end $$;

create or replace function public.admin_update_profile(
  p_user uuid, p_role public.user_role, p_active boolean, p_full_name text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admins int;
  v_old public.profiles;
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_old from public.profiles where user_id = p_user for update;
  if not found then raise exception 'user_not_found'; end if;
  if p_user = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'cannot_demote_self';
  end if;
  if v_old.role = 'admin' and (p_role <> 'admin' or not p_active) then
    select count(*) into v_admins from public.profiles where role = 'admin' and active and user_id <> p_user;
    if v_admins = 0 then raise exception 'last_admin'; end if;
  end if;
  update public.profiles
     set role = p_role, active = p_active,
         full_name = coalesce(left(btrim(p_full_name), 200), full_name)
   where user_id = p_user;
  perform public.write_audit('profile.update', 'profile', p_user::text,
    jsonb_build_object('role', p_role, 'active', p_active, 'old_role', v_old.role, 'old_active', v_old.active));
end $$;

-- ===========================================================================
-- Recipients import (server-side revalidation of what the client parsed)
-- p_rows: [{"email": "...", "meno": "...", "klub": "...", "pozicia": "..."}]
-- ===========================================================================
create or replace function public.campaign_set_recipients(p_campaign uuid, p_rows jsonb, p_replace boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.campaigns;
  v_row jsonb;
  v_email text;
  v_norm text;
  v_added int := 0;
  v_invalid int := 0;
  v_duplicate int := 0;
  v_suppressed int := 0;
  v_total int;
begin
  if not public.is_active_user() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_campaign from public.campaigns where id = p_campaign for update;
  if not found or v_campaign.owner_id <> auth.uid() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_campaign.status <> 'draft' then raise exception 'campaign_not_draft'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_payload'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'too_many_rows'; end if;

  if p_replace then
    delete from public.campaign_recipients where campaign_id = p_campaign;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_email := btrim(coalesce(v_row ->> 'email', ''));
    v_norm := public.normalize_email(v_email);
    if length(v_norm) > 254 or v_norm !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    if exists (select 1 from public.suppression_list s where s.email_normalized = v_norm) then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;
    insert into public.campaign_recipients (campaign_id, email, email_normalized, meno, klub, pozicia)
    values (
      p_campaign, v_email, v_norm,
      left(btrim(coalesce(v_row ->> 'meno', '')), 200),
      left(btrim(coalesce(v_row ->> 'klub', '')), 200),
      left(btrim(coalesce(v_row ->> 'pozicia', '')), 200)
    )
    on conflict (campaign_id, email_normalized) do nothing;
    if found then v_added := v_added + 1; else v_duplicate := v_duplicate + 1; end if;
  end loop;

  select count(*) into v_total from public.campaign_recipients where campaign_id = p_campaign;
  if v_total > 2000 then raise exception 'campaign_too_large'; end if;

  return jsonb_build_object('added', v_added, 'invalid', v_invalid, 'duplicate', v_duplicate,
                            'suppressed', v_suppressed, 'total', v_total);
end $$;

-- ===========================================================================
-- Campaign lifecycle
-- ===========================================================================
create or replace function public.campaign_confirm(
  p_campaign uuid,
  p_scheduled_at timestamptz,
  p_rate_per_minute integer,
  p_legal_basis public.legal_basis,
  p_legal_note text,
  p_acknowledged boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.campaigns;
  v_s public.sender_accounts;
  v_max_member int;
  v_queued int;
begin
  if not public.is_active_user() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_c from public.campaigns where id = p_campaign for update;
  if not found or v_c.owner_id <> auth.uid() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_c.status <> 'draft' then raise exception 'campaign_not_draft'; end if;
  if not coalesce(p_acknowledged, false) then raise exception 'acknowledgement_required'; end if;
  if p_legal_basis is null then raise exception 'legal_basis_required'; end if;
  if p_legal_basis = 'other_reviewed_basis' and length(btrim(coalesce(p_legal_note, ''))) < 10 then
    raise exception 'legal_note_required';
  end if;
  if v_c.sender_id is null or not public.can_use_sender(v_c.sender_id) then raise exception 'sender_not_permitted'; end if;
  select * into v_s from public.sender_accounts where id = v_c.sender_id;
  if not v_s.active or not v_s.credential_set or v_s.last_test_ok is not true then
    raise exception 'sender_not_ready';
  end if;
  if length(btrim(v_c.subject)) = 0 or length(btrim(v_c.body_text)) = 0 then raise exception 'content_missing'; end if;
  if p_scheduled_at is null or p_scheduled_at < now() - interval '2 minutes' then raise exception 'schedule_in_past'; end if;
  if p_scheduled_at > now() + interval '365 days' then raise exception 'schedule_too_far'; end if;

  select max_member_rate_per_minute into v_max_member from public.app_settings where id = 1;
  if p_rate_per_minute is null or p_rate_per_minute < 1 or p_rate_per_minute > v_s.rate_per_minute
     or (not public.is_admin() and p_rate_per_minute > v_max_member) then
    raise exception 'rate_not_allowed';
  end if;

  -- Suppression is enforced again at claim time; this makes the review counts accurate.
  update public.campaign_recipients r set state = 'skipped_unsubscribed'
   where r.campaign_id = p_campaign and r.state = 'queued'
     and exists (select 1 from public.suppression_list s where s.email_normalized = r.email_normalized);

  select count(*) into v_queued from public.campaign_recipients where campaign_id = p_campaign and state = 'queued';
  if v_queued = 0 then raise exception 'no_recipients'; end if;

  update public.campaigns
     set status = 'scheduled', status_reason = null,
         scheduled_at = greatest(p_scheduled_at, now()),
         rate_per_minute = p_rate_per_minute,
         legal_basis = p_legal_basis, legal_note = nullif(btrim(coalesce(p_legal_note, '')), ''),
         confirmed_at = now(), confirmed_by = auth.uid()
   where id = p_campaign;
  perform public.write_audit('campaign.confirm', 'campaign', p_campaign::text,
    jsonb_build_object('scheduled_at', p_scheduled_at, 'rate', p_rate_per_minute, 'legal_basis', p_legal_basis, 'queued', v_queued));
end $$;

create or replace function public.campaign_set_status(p_campaign uuid, p_action text)
returns public.campaign_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.campaigns;
  v_new public.campaign_status;
begin
  if not public.is_active_user() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_c from public.campaigns where id = p_campaign for update;
  if not found or (v_c.owner_id <> auth.uid() and not public.is_admin()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_action = 'pause' then
    if v_c.status not in ('scheduled', 'processing') then raise exception 'invalid_transition'; end if;
    v_new := 'paused';
    update public.campaigns set status = v_new, status_reason = 'Pozastavené používateľom.' where id = p_campaign;
  elsif p_action = 'resume' then
    if v_c.status <> 'paused' then raise exception 'invalid_transition'; end if;
    v_new := case when v_c.started_at is null and v_c.scheduled_at > now() then 'scheduled' else 'processing' end;
    update public.campaigns set status = v_new, status_reason = null where id = p_campaign;
    -- Messages held after a provider block become eligible again (one attempt each, paced).
    update public.campaign_recipients set next_attempt_at = now()
     where campaign_id = p_campaign and state = 'temporary_failure' and next_attempt_at is null;
  elsif p_action = 'cancel' then
    if v_c.status in ('completed', 'cancelled') then raise exception 'invalid_transition'; end if;
    v_new := 'cancelled';
    update public.campaigns set status = v_new, status_reason = 'Zrušené používateľom.', completed_at = now() where id = p_campaign;
    update public.campaign_recipients set state = 'cancelled', next_attempt_at = null
     where campaign_id = p_campaign and state in ('queued', 'temporary_failure');
  elsif p_action = 'unschedule' then
    -- Back to draft for editing; only before the first message was attempted.
    if v_c.status not in ('scheduled', 'paused') or v_c.started_at is not null then raise exception 'invalid_transition'; end if;
    if v_c.owner_id <> auth.uid() then raise exception 'not_authorized' using errcode = '42501'; end if;
    v_new := 'draft';
    update public.campaigns set status = v_new, status_reason = null, confirmed_at = null, confirmed_by = null,
           legal_basis = null, scheduled_at = null where id = p_campaign;
    update public.campaign_recipients set state = 'queued' where campaign_id = p_campaign and state = 'skipped_unsubscribed';
  else
    raise exception 'invalid_action';
  end if;
  perform public.write_audit('campaign.' || p_action, 'campaign', p_campaign::text, jsonb_build_object('from', v_c.status, 'to', v_new));
  return v_new;
end $$;

-- Operator decision for an unclear SMTP outcome. Never resolved automatically.
create or replace function public.recipient_resolve_unknown(p_recipient uuid, p_resolution text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.campaign_recipients;
  v_status public.campaign_status;
begin
  if not public.is_active_user() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_r from public.campaign_recipients where id = p_recipient for update;
  if not found or not public.can_view_campaign(v_r.campaign_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_r.state <> 'unknown_outcome' then raise exception 'invalid_transition'; end if;
  select status into v_status from public.campaigns where id = v_r.campaign_id;

  if p_resolution = 'accepted' then
    update public.campaign_recipients set state = 'accepted_by_smtp', accepted_at = coalesce(accepted_at, now()),
           last_error_category = 'manual_resolution', lease_token = null, lease_until = null where id = p_recipient;
  elsif p_resolution = 'failed' then
    update public.campaign_recipients set state = 'permanent_failure', last_error_category = 'manual_resolution',
           lease_token = null, lease_until = null where id = p_recipient;
  elsif p_resolution = 'requeue' then
    if v_status not in ('processing', 'paused', 'scheduled') then raise exception 'campaign_not_active'; end if;
    update public.campaign_recipients set state = 'queued', next_attempt_at = now(), lease_token = null, lease_until = null,
           last_error_category = 'manual_requeue' where id = p_recipient;
  else
    raise exception 'invalid_action';
  end if;
  perform public.write_audit('recipient.resolve_unknown', 'campaign_recipient', p_recipient::text,
    jsonb_build_object('resolution', p_resolution, 'campaign_id', v_r.campaign_id));
end $$;

-- ===========================================================================
-- Admin helpers
-- ===========================================================================
create or replace function public.sender_unblock(p_sender uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = '42501'; end if;
  update public.sender_accounts set blocked_until = null, blocked_reason = null where id = p_sender;
  perform public.write_audit('sender.unblock', 'sender_account', p_sender::text, '{}'::jsonb);
end $$;

-- Data-subject erasure: removes stored recipient rows for an address (except ones being sent right now)
-- and keeps the address on the suppression list so it is never contacted again.
create or replace function public.admin_erase_contact(p_email text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_norm text := public.normalize_email(p_email);
  v_count int;
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if exists (select 1 from public.campaign_recipients where email_normalized = v_norm and state = 'processing') then
    raise exception 'contact_in_flight';
  end if;
  delete from public.campaign_recipients where email_normalized = v_norm;
  get diagnostics v_count = row_count;
  insert into public.suppression_list (email_normalized, reason, note, created_by)
  values (v_norm, 'objection', 'Výmaz údajov na žiadosť', auth.uid())
  on conflict (email_normalized) do nothing;
  perform public.write_audit('contact.erase', 'contact', null, jsonb_build_object('deleted_rows', v_count));
  return v_count;
end $$;

-- Aggregated counters for dashboard (respects RLS through can_view_campaign).
create or replace function public.campaign_stats()
returns table (
  campaign_id uuid, total bigint, queued bigint, processing bigint, accepted bigint,
  failed bigint, skipped bigint, cancelled bigint, unknown bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.campaign_id,
         count(*),
         count(*) filter (where r.state in ('queued', 'temporary_failure')),
         count(*) filter (where r.state = 'processing'),
         count(*) filter (where r.state = 'accepted_by_smtp'),
         count(*) filter (where r.state = 'permanent_failure'),
         count(*) filter (where r.state = 'skipped_unsubscribed'),
         count(*) filter (where r.state = 'cancelled'),
         count(*) filter (where r.state = 'unknown_outcome')
    from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id
   where public.is_active_user() and (c.owner_id = auth.uid() or public.is_admin())
   group by r.campaign_id
$$;

-- ===========================================================================
-- Queue worker (service_role only)
-- ===========================================================================

-- Remaining sends allowed right now for a sender (rolling windows). Caller must hold the sender lock.
create or replace function public.sender_capacity(p_sender uuid)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_s public.sender_accounts;
  v_min int; v_hour int; v_day int;
begin
  select * into v_s from public.sender_accounts where id = p_sender;
  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at > now() - interval '1 hour'),
         count(*)
    into v_min, v_hour, v_day
    from public.send_attempts
   where sender_id = p_sender and outcome <> 'skipped' and created_at > now() - interval '24 hours';
  return greatest(0, least(v_s.rate_per_minute - v_min, v_s.hourly_cap - v_hour, v_s.daily_cap - v_day));
end $$;

create or replace function public.lock_sender(p_sender uuid)
returns void
language sql
set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended('cader-sender:' || p_sender::text, 0)) $$;

create or replace function public.claim_due_recipients(p_max integer default 10, p_lease_seconds integer default 300)
returns table (
  recipient_id uuid, lease_token uuid, attempt_id bigint, attempt_no integer,
  campaign_id uuid, sender_id uuid, email text, meno text, klub text, pozicia text,
  subject text, body_text text, unsubscribe_token text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_s record;
  v_c record;
  v_r record;
  v_cap int;
  v_ccap int;
  v_take int;
  v_total int := 0;
  v_token uuid;
  v_attempt bigint;
begin
  -- 1. Orphaned leases: the worker died mid-send. We cannot know whether SMTP accepted the
  --    message, so mark unknown_outcome for operator review. Never retried automatically.
  with expired as (
    update public.campaign_recipients
       set state = 'unknown_outcome', lease_until = null,
           last_error_category = 'lease_expired',
           last_error = 'Worker skončil bez potvrdenia výsledku. Skontrolujte odoslanú poštu.'
     where state = 'processing' and lease_until < now()
     returning id
  )
  update public.send_attempts a set outcome = 'unknown_outcome', error_category = 'lease_expired', finished_at = now()
    from expired e where a.recipient_id = e.id and a.outcome = 'in_progress';

  -- 2. Start campaigns whose time has come.
  update public.campaigns set status = 'processing', started_at = coalesce(started_at, now())
   where status = 'scheduled' and scheduled_at <= now();

  -- 3. Close finished campaigns.
  update public.campaigns c set status = 'completed', completed_at = now()
   where c.status = 'processing'
     and not exists (select 1 from public.campaign_recipients r
                      where r.campaign_id = c.id and r.state in ('queued', 'processing', 'temporary_failure'));

  select sending_enabled into v_enabled from public.app_settings where id = 1;
  if not coalesce(v_enabled, false) then return; end if;

  for v_s in
    select s.id from public.sender_accounts s
     where s.active and s.credential_set and s.last_test_ok is true
       and (s.blocked_until is null or s.blocked_until < now())
       and exists (select 1 from public.campaigns c where c.sender_id = s.id and c.status = 'processing')
     order by s.id
  loop
    exit when v_total >= p_max;
    perform public.lock_sender(v_s.id);
    v_cap := public.sender_capacity(v_s.id);
    continue when v_cap <= 0;

    for v_c in
      select c.id, c.subject, c.body_text, c.rate_per_minute from public.campaigns c
       where c.sender_id = v_s.id and c.status = 'processing'
       order by c.started_at, c.id
       for update skip locked
    loop
      exit when v_cap <= 0 or v_total >= p_max;

      -- Suppression is checked right before every claim.
      update public.campaign_recipients r set state = 'skipped_unsubscribed', next_attempt_at = null
       where r.campaign_id = v_c.id and r.state in ('queued', 'temporary_failure')
         and exists (select 1 from public.suppression_list s where s.email_normalized = r.email_normalized);

      select v_c.rate_per_minute - count(*) into v_ccap from public.send_attempts a
       where a.campaign_id = v_c.id and a.outcome <> 'skipped' and a.created_at > now() - interval '1 minute';
      v_take := least(v_cap, v_ccap, p_max - v_total);
      continue when v_take <= 0;

      for v_r in
        select r.* from public.campaign_recipients r
         where r.campaign_id = v_c.id
           and (r.state = 'queued' or (r.state = 'temporary_failure' and r.next_attempt_at is not null))
           and coalesce(r.next_attempt_at, '-infinity'::timestamptz) <= now()
         order by r.created_at, r.id
         limit v_take
         for update skip locked
      loop
        v_token := gen_random_uuid();
        update public.campaign_recipients
           set state = 'processing', lease_token = v_token,
               lease_until = now() + make_interval(secs => p_lease_seconds),
               attempts = attempts + 1, last_attempt_at = now(), next_attempt_at = null
         where id = v_r.id;
        insert into public.send_attempts (sender_id, recipient_id, campaign_id, attempt_no)
        values (v_s.id, v_r.id, v_c.id, v_r.attempts + 1)
        returning id into v_attempt;

        v_cap := v_cap - 1;
        v_total := v_total + 1;
        recipient_id := v_r.id; lease_token := v_token; attempt_id := v_attempt; attempt_no := v_r.attempts + 1;
        campaign_id := v_c.id; sender_id := v_s.id; email := v_r.email; meno := v_r.meno; klub := v_r.klub;
        pozicia := v_r.pozicia; subject := v_c.subject; body_text := v_c.body_text;
        unsubscribe_token := v_r.unsubscribe_token;
        return next;
      end loop;
    end loop;
  end loop;
end $$;

-- Re-check right before talking to SMTP: lease still ours and campaign still processing.
create or replace function public.recipient_still_sendable(p_recipient uuid, p_lease uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.campaign_recipients r
      join public.campaigns c on c.id = r.campaign_id
     where r.id = p_recipient and r.lease_token = p_lease and r.state = 'processing'
       and r.lease_until > now() and c.status = 'processing'
       and not exists (select 1 from public.suppression_list s where s.email_normalized = r.email_normalized)
  )
$$;

-- Release a claimed recipient without any SMTP attempt (campaign paused/cancelled in between).
create or replace function public.release_unsent(p_recipient uuid, p_lease uuid, p_attempt bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_suppressed boolean;
  v_status public.campaign_status;
begin
  select exists (select 1 from public.suppression_list s join public.campaign_recipients r
                   on r.email_normalized = s.email_normalized where r.id = p_recipient) into v_suppressed;
  select c.status into v_status from public.campaigns c join public.campaign_recipients r on r.campaign_id = c.id
   where r.id = p_recipient;
  update public.campaign_recipients
     set state = case when v_suppressed then 'skipped_unsubscribed'::public.recipient_state
                      when v_status = 'cancelled' then 'cancelled'::public.recipient_state
                      else 'queued'::public.recipient_state end,
         attempts = greatest(0, attempts - 1), lease_token = null, lease_until = null, next_attempt_at = null
   where id = p_recipient and lease_token = p_lease and state = 'processing';
  update public.send_attempts set outcome = 'skipped', finished_at = now() where id = p_attempt and outcome = 'in_progress';
end $$;

-- Persist the result of one SMTP attempt. Returns false if the lease is not ours any more.
create or replace function public.finish_attempt(
  p_recipient uuid, p_lease uuid, p_attempt bigint,
  p_outcome text, p_smtp_code integer, p_error_category text, p_error text, p_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.campaign_recipients;
  v_c public.campaigns;
  v_halt boolean := p_error_category in ('rate_limit', 'blocked', 'auth');
  v_error text := left(p_error, 1000);
begin
  select * into v_r from public.campaign_recipients
   where id = p_recipient and lease_token = p_lease and state in ('processing', 'unknown_outcome')
   for update;
  if not found then return false; end if;
  select * into v_c from public.campaigns where id = v_r.campaign_id;

  update public.send_attempts
     set outcome = p_outcome, smtp_code = p_smtp_code, error_category = p_error_category,
         error = v_error, finished_at = now()
   where id = p_attempt;

  if p_outcome = 'accepted_by_smtp' then
    update public.campaign_recipients
       set state = 'accepted_by_smtp', accepted_at = now(), smtp_message_id = p_message_id,
           lease_until = null, last_error_category = null, last_error = null
     where id = p_recipient;
  elsif p_outcome = 'unknown_outcome' then
    update public.campaign_recipients
       set state = 'unknown_outcome', lease_until = null, last_error_category = p_error_category, last_error = v_error
     where id = p_recipient;
  elsif p_outcome = 'permanent_failure' then
    update public.campaign_recipients
       set state = 'permanent_failure', lease_until = null, lease_token = null,
           last_error_category = p_error_category, last_error = v_error
     where id = p_recipient;
  elsif p_outcome = 'temporary_failure' then
    update public.campaign_recipients
       set state = case when not v_halt and v_r.attempts >= 3 then 'permanent_failure'::public.recipient_state
                        else 'temporary_failure'::public.recipient_state end,
           -- Halting errors wait for a human (next_attempt_at null); others back off 5, 10, 20 min.
           next_attempt_at = case when v_halt or v_r.attempts >= 3 then null
                                  else now() + make_interval(mins => 5 * (2 ^ (v_r.attempts - 1))::int) end,
           lease_until = null, lease_token = null,
           last_error_category = p_error_category, last_error = v_error
     where id = p_recipient;
  else
    raise exception 'invalid_outcome';
  end if;

  if v_halt then
    -- Provider limit / block / bad credentials: stop this sender entirely, no automatic retries.
    update public.sender_accounts
       set blocked_until = now() + interval '100 years',
           blocked_reason = left(coalesce(p_error_category, '') || ': ' || coalesce(v_error, ''), 500),
           last_test_ok = case when p_error_category = 'auth' then false else last_test_ok end
     where id = v_c.sender_id;
    update public.campaigns
       set status = 'paused',
           status_reason = 'Automaticky pozastavené: poskytovateľ odmietol odoslanie (' || p_error_category || ').'
     where sender_id = v_c.sender_id and status in ('processing', 'scheduled');
    insert into public.audit_logs (actor_id, action, entity, entity_id, details)
    values (null, 'sender.auto_block', 'sender_account', v_c.sender_id::text,
            jsonb_build_object('category', p_error_category, 'smtp_code', p_smtp_code));
  end if;

  update public.campaigns c set status = 'completed', completed_at = now()
   where c.id = v_c.id and c.status = 'processing'
     and not exists (select 1 from public.campaign_recipients r
                      where r.campaign_id = c.id and r.state in ('queued', 'processing', 'temporary_failure'));
  return true;
end $$;

-- Test messages count against the same per-sender caps.
create or replace function public.reserve_test_send(p_sender uuid, p_user uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.sender_accounts;
  v_id bigint;
  v_recent int;
begin
  select * into v_s from public.sender_accounts where id = p_sender;
  if not found or not v_s.active or not v_s.credential_set then raise exception 'sender_not_ready'; end if;
  if v_s.blocked_until is not null and v_s.blocked_until > now() then raise exception 'sender_blocked'; end if;
  perform public.lock_sender(p_sender);
  if public.sender_capacity(p_sender) <= 0 then raise exception 'rate_limited'; end if;
  select count(*) into v_recent from public.send_attempts
   where is_test and requested_by = p_user and created_at > now() - interval '1 hour';
  if v_recent >= 10 then raise exception 'test_quota_exceeded'; end if;
  insert into public.send_attempts (sender_id, is_test, requested_by) values (p_sender, true, p_user) returning id into v_id;
  return v_id;
end $$;

create or replace function public.finish_test_send(p_attempt bigint, p_outcome text, p_smtp_code integer, p_error_category text, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.send_attempts
     set outcome = p_outcome, smtp_code = p_smtp_code, error_category = p_error_category,
         error = left(p_error, 1000), finished_at = now()
   where id = p_attempt and is_test
$$;

-- Public unsubscribe (called by the unsubscribe Edge Function with service_role).
-- Returns only a boolean; never reveals the address or campaign.
create or replace function public.unsubscribe_by_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_norm text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  select email_normalized into v_norm from public.campaign_recipients where unsubscribe_token = p_token;
  if not found then return false; end if;
  insert into public.suppression_list (email_normalized, reason, note)
  values (v_norm, 'unsubscribe', 'Odhlásenie cez odkaz v e-maile')
  on conflict (email_normalized) do nothing;
  update public.campaign_recipients set state = 'skipped_unsubscribed', next_attempt_at = null
   where email_normalized = v_norm and state in ('queued', 'temporary_failure');
  return true;
end $$;

-- ===========================================================================
-- Privileges: default Supabase privileges grant EXECUTE to anon; reset explicitly.
-- ===========================================================================
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.is_admin(), public.is_active_user(), public.can_use_sender(uuid), public.can_view_campaign(uuid),
  public.normalize_email(text),
  public.update_my_name(text),
  public.admin_update_profile(uuid, public.user_role, boolean, text),
  public.campaign_set_recipients(uuid, jsonb, boolean),
  public.campaign_confirm(uuid, timestamptz, integer, public.legal_basis, text, boolean),
  public.campaign_set_status(uuid, text),
  public.recipient_resolve_unknown(uuid, text),
  public.sender_unblock(uuid),
  public.admin_erase_contact(text),
  public.campaign_stats()
to authenticated;

grant execute on function
  public.claim_due_recipients(integer, integer),
  public.recipient_still_sendable(uuid, uuid),
  public.release_unsent(uuid, uuid, bigint),
  public.finish_attempt(uuid, uuid, bigint, text, integer, text, text, text),
  public.reserve_test_send(uuid, uuid),
  public.finish_test_send(bigint, text, integer, text, text),
  public.unsubscribe_by_token(text),
  public.write_audit(text, text, text, jsonb),
  public.sender_capacity(uuid),
  public.lock_sender(uuid)
to service_role;
