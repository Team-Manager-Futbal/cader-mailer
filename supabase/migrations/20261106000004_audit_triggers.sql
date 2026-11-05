-- Audit trail for admin changes made directly through RLS-protected tables.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_details jsonb;
begin
  v_details := case tg_table_name
    when 'sender_permissions' then jsonb_build_object('user_id', v_row ->> 'user_id', 'sender_id', v_row ->> 'sender_id')
    when 'sender_accounts' then jsonb_build_object('email', v_row ->> 'email', 'active', v_row -> 'active',
      'rate_per_minute', v_row -> 'rate_per_minute', 'hourly_cap', v_row -> 'hourly_cap', 'daily_cap', v_row -> 'daily_cap')
    when 'app_settings' then jsonb_build_object('sending_enabled', v_row -> 'sending_enabled',
      'max_member_rate_per_minute', v_row -> 'max_member_rate_per_minute')
    when 'suppression_list' then jsonb_build_object('reason', v_row ->> 'reason')
    else '{}'::jsonb
  end;
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (auth.uid(), tg_table_name || '.' || lower(tg_op), tg_table_name,
          coalesce(v_row ->> 'id', v_row ->> 'sender_id', v_row ->> 'email_normalized'), v_details);
  return coalesce(new, old);
end $$;

create trigger audit_sender_permissions after insert or delete on public.sender_permissions
  for each row execute function public.audit_row_change();
create trigger audit_sender_accounts after insert or update or delete on public.sender_accounts
  for each row execute function public.audit_row_change();
create trigger audit_app_settings after update on public.app_settings
  for each row execute function public.audit_row_change();
-- Only deletions (re-enabling contact) are audited; additions are routine opt-outs.
create trigger audit_suppression_delete after delete on public.suppression_list
  for each row execute function public.audit_row_change();

revoke execute on function public.audit_row_change() from public, anon, authenticated;
