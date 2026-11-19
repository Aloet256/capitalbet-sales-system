# Capitalbet Slots and Live-in-Play Sales System

## Run on Windows

Use Node.js 24 or later. Run `npm ci`, then double-click `Start Capitalbet.cmd` or run `npm run dev` for local maintenance. Open [Branch sign-in](http://127.0.0.1:3000/) or [Administrator sign-in](http://127.0.0.1:3000/admin/login).

The maintenance server uses the existing `data/demo.sqlite` file and accepts loopback connections. Set `CAPITALBET_INITIAL_ADMIN_PASSWORD` for first-time setup and `CAPITALBET_PIN_KEY` in the private configuration. The application assigns random six-digit PINs and the Branch Management page lets the administrator view and reset them.

Staff can add or edit daily entries and review monthly totals. Administrators can switch between the two registers in Sales Overview, select a branch to see its daily entries, and add branches or set staff PINs in Branch Management. Changing a branch PIN ends existing staff sessions for that branch and preserves its sales entries.

Each branch and register carries its previous closing balance into the next month. Each recorded day shows the running balance after adding its movement. The carry-forward continues through months with no entries and updates automatically when earlier entries are corrected.

Run `npm test` to verify authentication, permissions, calculations, concurrent updates, PIN changes and persistence. Tests use separate temporary databases.

## Supabase setup

The Windows server reads settings from `%LOCALAPPDATA%\Capitalbet\config.env`. Use `CAPITALBET_CONFIG` to point at a different private configuration file, or supply settings in the server environment. Each line in the file uses `NAME=value`.

Set `DATABASE_URL` to the Supabase **Session pooler** connection string with the database password filled in. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `CAPITALBET_ADMIN_EMAIL` and `CAPITALBET_INITIAL_ADMIN_PASSWORD`. Set `CAPITALBET_PIN_KEY` to a securely generated 32-byte hexadecimal key and retain the same key across moves and restarts. Supabase's server secret key is used when the initial admin is created. The data connection uses TLS certificate verification. Set `SUPABASE_DB_CA_PATH` if the connection needs a separate CA file.

Run `npm run setup:supabase` to apply [the schema](supabase/schema.sql), import local sales, initialize missing branch PINs, and provision the administrator. It reads `data/demo.sqlite` by default. Set `CAPITALBET_SQLITE_SOURCE` to import another snapshot. Pause branch entry during cutover, then run the import and direct staff to the Supabase-backed app. A mismatch against an existing Supabase record stops the import without overwriting that record.

Configure custom SMTP in Supabase Authentication and add `<p>Your Capitalbet password reset code is <strong>{{ .Token }}</strong>.</p>` to the existing Reset password email template. The setup script can verify SMTP and append the code to the template when `SUPABASE_ACCESS_TOKEN` has Auth configuration permissions. For manual setup, set `CAPITALBET_RECOVERY_READY=1` once the SMTP service and template are ready. [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) and [SMTP settings](https://supabase.com/docs/guides/auth/auth-smtp).

Run `npm run dev:supabase` to verify the Supabase-backed system from the local computer. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the server configuration to enable notifications. Each successful entry queues an alert with the branch, date, submitted register, and both running balances. The running server delivers alerts and retries failures.

## Production setup

Deploy branch `main` to a Node.js 24 host using `npm ci` to build and `npm start` to start. Production requires the initialized Supabase database, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CAPITALBET_ADMIN_EMAIL`, and the same `CAPITALBET_PIN_KEY` used during import. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the host's private environment if Telegram is enabled. Keep the Supabase administrator provisioning key on the setup machine.

Set `CAPITALBET_TLS_CERT` and `CAPITALBET_TLS_KEY` to the certificate and key file paths for direct HTTPS. For an HTTPS reverse proxy, set `CAPITALBET_TRUST_PROXY=1` and `CAPITALBET_PUBLIC_ORIGIN` to the HTTPS origin with no trailing slash. Configure the proxy to overwrite `X-Forwarded-Proto` with `https` and `X-Forwarded-For` with the client address. Loopback proxies are recognized automatically in this mode. Set `CAPITALBET_PROXY_IPS` to a comma-separated list of additional trusted proxy addresses if required. The production process honors the host's `PORT` environment variable. Set `CAPITALBET_BIND` and `CAPITALBET_PORT` to override the default bind address or port on a self-managed host.

The public GitHub Pages address publishes the Capitalbet entry page from `pages/`. Authentication, data writes and Telegram delivery run on the Node.js server. Once the app has an HTTPS address, set the GitHub Actions repository variable `CAPITALBET_APP_URL` to its origin and run **Publish Capitalbet entry page**. The page will send staff and administrators to their respective sign-in pages. [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
