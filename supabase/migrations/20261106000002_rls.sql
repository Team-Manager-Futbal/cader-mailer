-- Cader Mailer: Row Level Security and table privileges.
-- Every table in the exposed schema has RLS enabled. anon has no access to any table.

alter table public.profiles            enable row level security;
alter table public.app_settings        enable row level security;
alter table public.sender_accounts     enable row level security;
alter table public.sender_secrets      enable row level security;
alter table public.sender_permissions  enable row level security;
alter table public.templates           enable row level security;
alter table public.campaigns           enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.send_attempts       enable row level security;
alter table public.suppression_list    enable row level security;
alter table public.audit_logs          enable row level security;

-- Start from zero privileges and grant explicitly.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon;

-- Helper functions used inside policies must be executable by authenticated.
grant execute on function public.is_admin(), public.is_active_user(), public.can_use_sender(uuid),
  public.normalize_email(text) to authenticated;

create or replace function public.can_view_campaign(p_campaign uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or (
    public.is_active_user() and exists (
      select 1 from public.campaigns c where c.id = p_campaign and c.owner_id = auth.uid()
    )
  )
$$;
revoke execute on function public.can_view_campaign(uuid) from public, anon;
grant execute on function public.can_view_campaign(uuid) to authenticated;

-- profiles ------------------------------------------------------------------
grant select on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- Writes only through admin_update_profile / update_my_name RPCs.

-- app_settings --------------------------------------------------------------
grant select on public.app_settings to authenticated;
grant update (sending_enabled, max_member_rate_per_minute, frontend_url, footer_text, test_recipient_allowlist)
  on public.app_settings to authenticated;
create policy app_settings_select on public.app_settings for select to authenticated
  using (public.is_active_user());
create policy app_settings_update on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- sender_accounts -----------------------------------------------------------
grant select, delete on public.sender_accounts to authenticated;
grant insert (email, display_name, provider, smtp_host, smtp_port, smtp_tls, smtp_username, reply_to,
  rate_per_minute, hourly_cap, daily_cap)
  on public.sender_accounts to authenticated;
grant update (email, display_name, provider, smtp_host, smtp_port, smtp_tls, smtp_username, reply_to, active,
  rate_per_minute, hourly_cap, daily_cap)
  on public.sender_accounts to authenticated;
create policy sender_accounts_select on public.sender_accounts for select to authenticated
  using (public.can_use_sender(id));
create policy sender_accounts_insert on public.sender_accounts for insert to authenticated
  with check (public.is_admin());
create policy sender_accounts_update on public.sender_accounts for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy sender_accounts_delete on public.sender_accounts for delete to authenticated
  using (public.is_admin());

-- Connection details changed => previous SMTP test no longer valid, must re-test before sending.
create or replace function public.sender_accounts_invalidate_test()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.email, new.smtp_host, new.smtp_port, new.smtp_tls, new.smtp_username)
     is distinct from (old.email, old.smtp_host, old.smtp_port, old.smtp_tls, old.smtp_username) then
    new.last_test_ok := null;
    new.last_test_message := 'Nastavenia pripojenia sa zmenili, otestujte pripojenie znova.';
  end if;
  return new;
end $$;
create trigger sender_accounts_invalidate_test before update on public.sender_accounts
  for each row execute function public.sender_accounts_invalidate_test();

-- sender_secrets: no grants, no policies. Only service_role (Edge Functions) can touch it.

-- sender_permissions --------------------------------------------------------
grant select, insert, delete on public.sender_permissions to authenticated;
create policy sender_permissions_select on public.sender_permissions for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_user()));
create policy sender_permissions_insert on public.sender_permissions for insert to authenticated
  with check (public.is_admin() and granted_by = auth.uid());
create policy sender_permissions_delete on public.sender_permissions for delete to authenticated
  using (public.is_admin());

-- templates -----------------------------------------------------------------
grant select, delete on public.templates to authenticated;
grant insert (owner_id, name, subject, body_text, shared) on public.templates to authenticated;
grant update (name, subject, body_text, shared) on public.templates to authenticated;
create policy templates_select on public.templates for select to authenticated
  using (public.is_active_user() and (shared or owner_id = auth.uid() or public.is_admin()));
create policy templates_insert on public.templates for insert to authenticated
  with check (public.is_active_user() and owner_id = auth.uid());
create policy templates_update on public.templates for update to authenticated
  using (public.is_active_user() and (owner_id = auth.uid() or public.is_admin()))
  with check (public.is_active_user() and (owner_id = auth.uid() or public.is_admin()));
create policy templates_delete on public.templates for delete to authenticated
  using (public.is_active_user() and (owner_id = auth.uid() or public.is_admin()));

-- campaigns -----------------------------------------------------------------
-- Status, confirmation and scheduling columns are only changed through RPCs.
grant select, delete on public.campaigns to authenticated;
grant insert (owner_id, sender_id, name, subject, body_text, rate_per_minute) on public.campaigns to authenticated;
grant update (sender_id, name, subject, body_text, rate_per_minute) on public.campaigns to authenticated;
create policy campaigns_select on public.campaigns for select to authenticated
  using (public.is_active_user() and (owner_id = auth.uid() or public.is_admin()));
create policy campaigns_insert on public.campaigns for insert to authenticated
  with check (
    public.is_active_user() and owner_id = auth.uid() and status = 'draft'
    and (sender_id is null or public.can_use_sender(sender_id))
  );
create policy campaigns_update on public.campaigns for update to authenticated
  using (public.is_active_user() and owner_id = auth.uid() and status = 'draft')
  with check (
    public.is_active_user() and owner_id = auth.uid() and status = 'draft'
    and (sender_id is null or public.can_use_sender(sender_id))
  );
create policy campaigns_delete on public.campaigns for delete to authenticated
  using (public.is_active_user() and owner_id = auth.uid() and status = 'draft');

-- campaign_recipients -------------------------------------------------------
-- Inserts go through campaign_set_recipients (server-side revalidation + suppression).
grant select, delete on public.campaign_recipients to authenticated;
create policy recipients_select on public.campaign_recipients for select to authenticated
  using (public.can_view_campaign(campaign_id));
create policy recipients_delete on public.campaign_recipients for delete to authenticated
  using (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and c.owner_id = auth.uid() and c.status = 'draft'
  ) and public.is_active_user());

-- send_attempts -------------------------------------------------------------
grant select on public.send_attempts to authenticated;
create policy send_attempts_select on public.send_attempts for select to authenticated
  using (
    public.is_admin()
    or (campaign_id is not null and public.can_view_campaign(campaign_id))
    or (is_test and requested_by = auth.uid() and public.is_active_user())
  );

-- suppression_list ----------------------------------------------------------
grant select, delete on public.suppression_list to authenticated;
grant insert (email_normalized, reason, note, created_by) on public.suppression_list to authenticated;
create policy suppression_select on public.suppression_list for select to authenticated
  using (public.is_active_user());
create policy suppression_insert on public.suppression_list for insert to authenticated
  with check (public.is_active_user() and created_by = auth.uid() and reason in ('manual', 'objection'));
create policy suppression_delete on public.suppression_list for delete to authenticated
  using (public.is_admin());

-- audit_logs ----------------------------------------------------------------
grant select on public.audit_logs to authenticated;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (public.is_admin());
