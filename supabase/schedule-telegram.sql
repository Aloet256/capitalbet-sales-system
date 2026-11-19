-- Set capitalbet_function_url and capitalbet_cron_secret in Supabase Vault before running.
-- The URL ends with /functions/v1/capitalbet/cron/telegram.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule('capitalbet-telegram-outbox', '* * * * *', $job$
  SELECT net.http_post(
    url := endpoint.decrypted_secret,
    headers := jsonb_build_object('Authorization', 'Bearer ' || access.decrypted_secret),
    timeout_milliseconds := 45000
  )
  FROM (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'capitalbet_function_url' LIMIT 1) AS endpoint
  CROSS JOIN (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'capitalbet_cron_secret' LIMIT 1) AS access;
$job$);
