# Capitalbet Slots and Live-in-Play Sales System

## Open Capitalbet

Open the [Capitalbet sales system](https://aloet256.github.io/capitalbet-sales-system/) or double-click `Start Capitalbet.cmd`. GitHub Pages serves the full app. Supabase runs the API, authenticates the administrator, and stores sales, sessions, and branch PINs. The system runs independently of the Windows computer.

Staff can add daily entries, edit them through the end of the entry date in East Africa Time, and review monthly totals. After midnight, an administrator can correct a saved entry by selecting its branch and register in Sales Overview and choosing **Edit** on the relevant date. Staff can fill in days that have no saved entry. Administrators can add branches and set staff PINs in Branch Management. Changing a branch PIN ends existing staff sessions for that branch and preserves its sales entries.

Sales Overview and individual branch registers update as entries are saved while the administrator has the page open.

Each branch and register carries its previous closing balance into the next month. Each recorded day shows the running balance after adding its movement. The carry-forward continues through months with no entries and updates automatically when earlier entries are corrected.

## Deploy on GitHub Pages and Supabase

### Prepare Supabase and import existing sales

Use Node.js 24 and run `npm ci` on the setup computer. The setup script reads `%LOCALAPPDATA%\Capitalbet\config.env`. Use `CAPITALBET_CONFIG` to point at a different private configuration file, or supply settings in the environment. Each line in the file uses `NAME=value`.

Set `DATABASE_URL` to the Supabase **Session pooler** connection string with the database password filled in. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `CAPITALBET_ADMIN_EMAIL` and `CAPITALBET_INITIAL_ADMIN_PASSWORD`. Set `CAPITALBET_PIN_KEY` to a securely generated 32-byte hexadecimal key and retain the same key across moves and restarts. Supabase's server secret key is used when the initial admin is created. The data connection uses TLS certificate verification. Set `SUPABASE_DB_CA_PATH` if the connection needs a separate CA file.

Run `npm run setup:supabase` to apply [the schema](supabase/schema.sql), import local sales, initialize missing branch PINs, and provision the administrator. It reads `data/demo.sqlite` by default. Set `CAPITALBET_SQLITE_SOURCE` to import another snapshot. Pause branch entry during cutover, then run the import and direct staff to the Supabase-backed app. A mismatch against an existing Supabase record stops the import without overwriting that record.

Configure custom SMTP in Supabase Authentication and add `<p>Your Capitalbet password reset code is <strong>{{ .Token }}</strong>.</p>` to the existing Reset password email template. The setup script can verify SMTP and append the code to the template when `SUPABASE_ACCESS_TOKEN` has Auth configuration permissions. For manual setup, set `CAPITALBET_RECOVERY_READY=1` once the SMTP service and template are ready. [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) and [SMTP settings](https://supabase.com/docs/guides/auth/auth-smtp).

### Deploy the Supabase Edge Function

1. Set `CAPITALBET_PIN_KEY` and `CAPITALBET_ADMIN_EMAIL` in Supabase **Edge Function Secrets**. Use the same PIN key as for the import. Supabase supplies its database URL and API keys to the function directly. Set `CAPITALBET_RECOVERY_READY=1` only after configuring the reset email.
2. Set the GitHub repository variable `CAPITALBET_SUPABASE_URL` to the hosted Supabase project origin, such as `https://abcdefghijklmnopqrst.supabase.co`. The Pages build publishes this public URL and the browser assets.
3. To deploy from GitHub, add the `SUPABASE_ACCESS_TOKEN` repository secret with permission to deploy Edge Functions for the project, then run [Deploy Capitalbet API to Supabase](https://github.com/Aloet256/capitalbet-sales-system/actions/workflows/supabase.yml). To deploy directly with a signed-in CLI, run `npx --yes supabase@3.2.0 functions deploy capitalbet --remote=YOUR_PROJECT_REF --use-api --yes`.
4. Run [Publish Capitalbet app](https://github.com/Aloet256/capitalbet-sales-system/actions/workflows/pages.yml) if needed. Check staff sign-in at the public URL and administrator sign-in at `/#/admin/login` within the same GitHub Pages site. Confirm the expected branches and sales figures after signing in.

The `capitalbet` function only accepts browser requests from `https://aloet256.github.io` by default. Set the `CAPITALBET_SITE_ORIGIN` Edge Function secret if you use a GitHub Pages custom origin. The application validates its own expiring session tokens and authorizes each role server-side.

### Telegram notifications

Set `CAPITALBET_TELEGRAM_BOT_TOKEN`, `CAPITALBET_TELEGRAM_CHAT_ID`, and a randomly generated `CAPITALBET_CRON_SECRET` in Edge Function Secrets. Create two Supabase Vault secrets for scheduled retries. Set `capitalbet_function_url` to the project URL followed by `/functions/v1/capitalbet/cron/telegram` and `capitalbet_cron_secret` to the same cron secret. Run [the Telegram schedule](supabase/schedule-telegram.sql) in the Supabase SQL Editor. Alerts identify new and updated staff entries and show Cash at Hand for the selected register through the entry date. Supabase Cron retries pending alerts every minute.

## Tests

Run `npm test` to verify authentication, permissions, calculations, concurrent updates, PIN changes and persistence. GitHub Actions also tests the Supabase schema and storage adapter with a disposable PostgreSQL database.
