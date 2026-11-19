# Capitalbet Slots and Live-in-Play Sales System

## Open Capitalbet

Open the [Capitalbet entry page](https://aloet256.github.io/capitalbet-sales-system/) or double-click `Start Capitalbet.cmd`. After cloud setup, the page offers branch and administrator sign-in. The Node.js service and Supabase database run independently of the Windows computer.

Staff can add or edit daily entries and review monthly totals. Administrators can switch between the two registers in Sales Overview, select a branch to see its daily entries, and add branches or set staff PINs in Branch Management. Changing a branch PIN ends existing staff sessions for that branch and preserves its sales entries.

Each branch and register carries its previous closing balance into the next month. Each recorded day shows the running balance after adding its movement. The carry-forward continues through months with no entries and updates automatically when earlier entries are corrected.

## Deploy on Render and Supabase

### Prepare Supabase and import existing sales

Use Node.js 24 and run `npm ci` on the setup computer. The setup script reads `%LOCALAPPDATA%\Capitalbet\config.env`. Use `CAPITALBET_CONFIG` to point at a different private configuration file, or supply settings in the environment. Each line in the file uses `NAME=value`.

Set `DATABASE_URL` to the Supabase **Session pooler** connection string with the database password filled in. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `CAPITALBET_ADMIN_EMAIL` and `CAPITALBET_INITIAL_ADMIN_PASSWORD`. Set `CAPITALBET_PIN_KEY` to a securely generated 32-byte hexadecimal key and retain the same key across moves and restarts. Supabase's server secret key is used when the initial admin is created. The data connection uses TLS certificate verification. Set `SUPABASE_DB_CA_PATH` if the connection needs a separate CA file.

Run `npm run setup:supabase` to apply [the schema](supabase/schema.sql), import local sales, initialize missing branch PINs, and provision the administrator. It reads `data/demo.sqlite` by default. Set `CAPITALBET_SQLITE_SOURCE` to import another snapshot. Pause branch entry during cutover, then run the import and direct staff to the Supabase-backed app. A mismatch against an existing Supabase record stops the import without overwriting that record.

Configure custom SMTP in Supabase Authentication and add `<p>Your Capitalbet password reset code is <strong>{{ .Token }}</strong>.</p>` to the existing Reset password email template. The setup script can verify SMTP and append the code to the template when `SUPABASE_ACCESS_TOKEN` has Auth configuration permissions. For manual setup, set `CAPITALBET_RECOVERY_READY=1` once the SMTP service and template are ready. [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) and [SMTP settings](https://supabase.com/docs/guides/auth/auth-smtp).

### Start the cloud service and link the entry page

1. Create a [Render Blueprint](https://dashboard.render.com/blueprints) using this GitHub repository and its `main` branch. The [Blueprint](render.yaml) provisions a paid web service that stays running between visits. Review the plan before applying it. [Render web services](https://render.com/docs/web-services) and [pricing](https://render.com/pricing).
2. Enter the values requested by the Blueprint in Render's private environment settings, including the same `CAPITALBET_PIN_KEY` used during the import. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` there to enable notifications. Keep `SUPABASE_SECRET_KEY`, `SUPABASE_ACCESS_TOKEN` and `CAPITALBET_INITIAL_ADMIN_PASSWORD` in the private setup configuration. For a custom Supabase database CA, add it as a Render secret file and set `SUPABASE_DB_CA_PATH` to that file's path.
3. After the deploy is healthy, open its HTTPS URL and check `/` and `/admin/login`. Confirm administrator sign-in and verify that the expected branches and sales figures are present.
4. Set the GitHub Actions repository variable `CAPITALBET_APP_URL` to the deployed HTTPS origin. Run **Publish Capitalbet entry page** from the repository's [Actions tab](https://github.com/Aloet256/capitalbet-sales-system/actions/workflows/pages.yml). Verify that both sign-in links work from the GitHub Pages address before sending staff there.

Render supplies the app's public HTTPS origin and terminates TLS at its edge. If using a custom domain, set `CAPITALBET_PUBLIC_ORIGIN` to that HTTPS origin and update `CAPITALBET_APP_URL` to match. The service queues Telegram alerts for successful entries and retries failed deliveries while running in the cloud.

### Other Node.js hosts

Build with `npm ci` and start with `npm start`. Set `CAPITALBET_TLS_CERT` and `CAPITALBET_TLS_KEY` to the certificate and key file paths for direct HTTPS. For an HTTPS reverse proxy, set `CAPITALBET_TRUST_PROXY=1` and `CAPITALBET_PUBLIC_ORIGIN` to the HTTPS origin with no trailing slash. Configure the proxy to overwrite `X-Forwarded-Proto` with `https` and `X-Forwarded-For` with the client address. Loopback proxies are recognized automatically in this mode. Set `CAPITALBET_PROXY_IPS` to a comma-separated list of additional trusted proxy addresses if required. The production process honors the host's `PORT` environment variable. Set `CAPITALBET_BIND` and `CAPITALBET_PORT` to override the default bind address or port on a self-managed host.

## Tests

Run `npm test` to verify authentication, permissions, calculations, concurrent updates, PIN changes and persistence. GitHub Actions also tests the Supabase schema and storage adapter with a disposable PostgreSQL database.
