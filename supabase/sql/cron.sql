-- Run ONCE in the Supabase SQL editor after deploying the Edge Functions.
-- It schedules the queue processor every minute. Secrets come from Supabase Vault,
-- so nothing secret is stored in this file, in migrations or in cron.job.
--
-- 1) Enable extensions (Dashboard → Database → Extensions, or):
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Store the two values in Vault (replace the placeholders IN THE SQL EDITOR ONLY,
--    never commit real values):
--      select vault.create_secret('https://<project-ref>.supabase.co', 'cader_project_url');
--      select vault.create_secret('<the same CRON_SECRET you set with supabase secrets set>', 'cader_cron_secret');

-- 3) Schedule (re-running replaces the job with the same name):
select cron.schedule(
  'cader-process-queue',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cader_project_url') || '/functions/v1/process-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cader_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

-- Check it runs (status should be 'succeeded'; the HTTP result is in net._http_response):
--   select jobname, status, start_time, return_message from cron.job_run_details order by start_time desc limit 10;
--   select status_code, content::text, created from net._http_response order by created desc limit 10;
-- Stop the scheduler entirely:
--   select cron.unschedule('cader-process-queue');
