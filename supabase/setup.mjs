import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { supabaseClient } from '../admin-recovery.mjs';
import { branchNames } from '../branches.mjs';
import { configFile, loadConfig, postgresOptions } from '../config.mjs';
import { createPinVault } from '../credentials.mjs';
import { makePool, postgresTransaction } from '../postgres-store.mjs';
import { withBalance } from '../public/sales.mjs';

export function sqliteSnapshot(path) {
  if (!existsSync(path)) return { branches: [], entries: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const sealed = db.prepare('PRAGMA table_info(branches)').all().some(column => column.name === 'pin_cipher');
    return {
      branches: db.prepare(`SELECT id, name, pin_hash, ${sealed ? 'pin_cipher' : 'NULL AS pin_cipher'} FROM branches ORDER BY id`).all(),
      entries: db.prepare('SELECT branch_id, kind, day, amounts, revision FROM entries ORDER BY branch_id, day, kind').all(),
    };
  } finally {
    db.close();
  }
}

export async function importSales(pool, snapshot, pinVault) {
  const names = new Set([...snapshot.branches.map(branch => branch.name), ...branchNames]);
  const sourceByName = new Map(snapshot.branches.map(branch => [branch.name, branch]));
  const existing = await pool.query('SELECT name, pin_cipher FROM capitalbet.branches');
  const present = new Set(existing.rows.map(branch => branch.name));
  for (const branch of existing.rows) pinVault.reveal(branch.name, branch.pin_cipher);
  const missing = await Promise.all([...names].filter(name => !present.has(name)).map(async name => {
    const source = sourceByName.get(name);
    if (!source?.pin_cipher) return { name, ...await pinVault.protect(name) };
    pinVault.reveal(name, source.pin_cipher);
    return { name, hash: source.pin_hash, cipher: source.pin_cipher };
  }));

  return postgresTransaction(pool, async client => {
    for (const branch of missing) {
      await client.query(`INSERT INTO capitalbet.branches (name, pin_hash, pin_cipher)
        VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`, [branch.name, branch.hash, branch.cipher]);
    }
    const result = await client.query('SELECT id, name FROM capitalbet.branches');
    const destination = new Map(result.rows.map(branch => [branch.name, branch.id]));
    const sourceBranch = new Map(snapshot.branches.map(branch => [branch.id, branch.name]));
    for (const entry of snapshot.entries) {
      const balance = withBalance(entry.kind, JSON.parse(entry.amounts)).balance;
      const params = [destination.get(sourceBranch.get(entry.branch_id)), entry.kind, entry.day, entry.amounts, balance, entry.revision];
      const inserted = await client.query(`INSERT INTO capitalbet.entries (branch_id, kind, day, amounts, net_balance, revision)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (branch_id, kind, day) DO NOTHING`, params);
      if (inserted.rowCount) continue;
      const identical = await client.query(`SELECT 1 FROM capitalbet.entries WHERE branch_id = $1 AND kind = $2 AND day = $3
        AND amounts = $4::jsonb AND net_balance = $5 AND revision = $6`, params);
      if (!identical.rows.length) throw new Error(`A Supabase entry differs from the local entry for ${sourceBranch.get(entry.branch_id)} on ${entry.day}. The import was rolled back.`);
    }
    return { branches: destination.size, entries: snapshot.entries.length };
  });
}

async function provisionAdmin(pool, env) {
  const email = env.CAPITALBET_ADMIN_EMAIL;
  const password = env.CAPITALBET_INITIAL_ADMIN_PASSWORD;
  const known = (await pool.query("SELECT value FROM capitalbet.config WHERE key = 'admin_user_id'")).rows[0]?.value;
  const existing = (await pool.query("SELECT id, raw_app_meta_data->>'capitalbet_admin' AS managed FROM auth.users WHERE lower(email) = lower($1)", [email])).rows[0];
  if (known && known !== existing?.id) throw new Error('The Supabase project already has a different Capitalbet administrator configured.');
  if (known) return;
  let userId = existing?.id;
  if (userId && existing.managed !== 'true') {
    const { data, error } = await supabaseClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY).auth.signInWithPassword({ email, password });
    if (error || data.user?.id !== userId) throw new Error('That email belongs to an existing Supabase user with a different password. No password was changed.');
  }
  if (!userId) {
    if (!env.SUPABASE_SECRET_KEY) throw new Error('Set SUPABASE_SECRET_KEY to create the administrator user.');
    const admin = supabaseClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY).auth.admin;
    const { data, error } = await admin.createUser({ email, password, email_confirm: true, app_metadata: { capitalbet_admin: true } });
    if (error || !data.user?.id) throw new Error(`Supabase could not create the administrator account${error?.code ? ` (${error.code})` : ''}.`);
    userId = data.user.id;
  }
  await pool.query("INSERT INTO capitalbet.config (key, value) VALUES ('admin_user_id', $1) ON CONFLICT DO NOTHING", [userId]);
}

async function addEmailCode(env) {
  if (!env.SUPABASE_ACCESS_TOKEN) {
    console.log('Add {{ .Token }} to the Reset password email template in Supabase to deliver a numeric code.');
    return;
  }
  const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0];
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error('The Supabase project URL needs its original project hostname for template setup.');
  const route = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
  const settings = await fetch(route, { headers, signal: AbortSignal.timeout(10_000) });
  if (!settings.ok) throw new Error(`The password recovery template could not be read (${settings.status}).`);
  const { mailer_templates_recovery_content: template } = await settings.json();
  if (/{{\s*\.Token\s*}}/.test(template ?? '')) return;
  const previous = template || '<h2>Reset your password</h2><p><a href="{{ .ConfirmationURL }}">Reset password</a></p>';
  const result = await fetch(route, { method: 'PATCH', headers, signal: AbortSignal.timeout(10_000), body: JSON.stringify({
    mailer_templates_recovery_content: `${previous}\n<p>Your Capitalbet password reset code is <strong>{{ .Token }}</strong>.</p>`,
  }) });
  if (!result.ok) throw new Error(`The password recovery template could not be updated (${result.status}).`);
  console.log('Added the numeric code to the Supabase password recovery template.');
}

async function main() {
  const env = loadConfig();
  if (!env.DATABASE_URL) throw new Error(`Set DATABASE_URL in ${configFile()} before running Supabase setup.`);
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.CAPITALBET_ADMIN_EMAIL) throw new Error('The Supabase URL, publishable key and administrator email are required.');
  const pinVault = createPinVault(env.CAPITALBET_PIN_KEY);
  if (!pinVault) throw new Error('Set the private CAPITALBET_PIN_KEY first.');
  const pool = makePool(postgresOptions(env));
  try {
    await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    const source = env.CAPITALBET_SQLITE_SOURCE ?? resolve('data', 'demo.sqlite');
    const imported = await importSales(pool, sqliteSnapshot(source), pinVault);
    console.log(`Supabase has ${imported.branches} branches. Verified ${imported.entries} local sales entries in Supabase.`);
    await provisionAdmin(pool, env);
    console.log('The administrator account is provisioned in Supabase.');
    await addEmailCode(env);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.code ? `Supabase setup could not complete (${error.code}). Check the private project settings.` : error.message);
    process.exitCode = 1;
  });
}
