import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi } from '../api.mjs';
import { createApplication } from '../server.mjs';
import { createPinVault } from '../credentials.mjs';
import { createEdgeHandler } from '../edge.mjs';
import { makePool, openPostgresStore } from '../postgres-store.mjs';
import { daysInMonth } from '../public/sales.mjs';
import { importSales } from '../supabase/setup.mjs';

async function listen(options) {
  const defaults = options.local ? { adminPassword: fixtureAdminPassword, initialBranchPin: '1234' } : {};
  const server = await createApplication({ ...defaults, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function client(origin, defaults = {}) {
  let cookie;
  return async (path, { method = 'GET', body, headers = {}, signal } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method, signal,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...defaults, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.get('Set-Cookie');
    if (set) cookie = set.split(';')[0];
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}

const month = '2028-02';
const slots = { totalIn: 100_000, totalOut: 24_000, expenses: 4_000, cashIn: 12_000, cashOut: 3_000, freeCoupons: 1_000 };
const live = { totalIn: 15_000, totalOut: 18_000, tickets: 4 };
const fixtureAdminPassword = 'Capitalbet-admin-fixture';
const login = (session, branchId, pin = '1234') => session('/api/login/staff', { method: 'POST', body: { branchId, pin } });
const adminLogin = (session, password = fixtureAdminPassword) => session('/api/login/admin', { method: 'POST', body: { password } });
const read = (session, kind, period = month) => session(`/api/registers/${kind}?month=${period}`);
const save = (session, kind, values, revision = 0, day = `${month}-29`) => session(`/api/registers/${kind}/${day}`, { method: 'PUT', body: { revision, values } });
const correct = (session, branchId, kind, day, values, revision) => session(`/api/admin/branches/${branchId}/${kind}/${day}`, {
  method: 'PUT', body: { revision, values },
});

test('staff and administrator flows with persistent and isolated registers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2028-02-29T20:59:00Z') });
  const directory = await mkdtemp(join(tmpdir(), 'capitalbet-local-'));
  const options = { local: true, filename: join(directory, 'database.sqlite') };
  let app = await listen(options);
  t.after(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const staff = client(app.origin);
  const other = client(app.origin);
  const admin = client(app.origin);
  const anonymous = client(app.origin);

  const branches = (await anonymous('/api/branches')).body.branches;
  assert.equal(branches.length, 53);
  for (const path of ['/', '/dashboard', '/slots', '/live', '/admin/login', '/admin', '/admin/branches', `/admin/branches/${branches[0].id}/live`, '/app.mjs', '/ui.mjs', '/sales.mjs', '/styles.css', '/capitalbet-logo.png']) {
    assert.equal((await fetch(`${app.origin}${path}`)).status, 200, path);
  }
  assert.equal((await read(anonymous, 'slots')).status, 401);
  assert.equal((await login(staff, branches[0].id, '0000')).status, 401);
  const signedIn = await login(staff, branches[0].id);
  assert.equal(signedIn.body.session.branch.name, branches[0].name);
  assert.match(signedIn.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await login(other, branches[1].id)).status, 200);
  assert.equal((await staff(`/api/admin/overview?month=${month}`)).status, 403);
  assert.equal((await adminLogin(admin)).status, 200);
  assert.equal((await read(admin, 'slots')).status, 403);
  assert.equal((await staff('/api/logout', { method: 'POST', body: {}, headers: { Origin: 'https://different.example' } })).status, 403);

  assert.equal(daysInMonth(month).length, 29);
  assert.equal(daysInMonth('2026-02').length, 28);
  assert.equal(daysInMonth('2026-11').length, 30);
  assert.equal(daysInMonth('2026-12').length, 31);
  assert.equal((await save(staff, 'slots', slots, 0, '2026-02-29')).status, 400);
  assert.equal((await save(staff, 'live', { ...live, tickets: 4.5 })).status, 400);
  assert.equal((await save(staff, 'slots', slots)).body.record.values.balance, 80_000);
  assert.equal((await save(staff, 'live', live)).body.record.values.balance, -3_000);
  const concurrent = await Promise.all([save(staff, 'slots', slots, 1), save(staff, 'slots', slots, 1)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  assert.deepEqual((await read(other, 'slots')).body.records, []);
  const snapshot = (await admin(`/api/admin/overview?month=${month}`)).body;
  assert.deepEqual(snapshot.totals.slots, { balance: 80_000, ...slots, openingBalance: 0, monthlyMovement: 80_000 });
  assert.deepEqual(snapshot.totals.live, { balance: -3_000, ...live, openingBalance: 0, monthlyMovement: -3_000 });
  assert.equal(snapshot.branches.find(branch => branch.id === branches[0].id).entries, 2);
  assert.deepEqual(snapshot.branches.find(branch => branch.id === branches[0].id).entriesByRegister, { slots: 1, live: 1 });
  const detail = (await admin(`/api/admin/branches/${branches[0].id}/slots?month=${month}`)).body;
  assert.equal(detail.records[0].revision, 2);
  assert.equal(detail.branch.id, branches[0].id);

  const create = { method: 'POST', body: { name: '  Test   Branch ', pin: '6789' } };
  const added = await admin('/api/admin/branches', create);
  assert.equal(added.status, 201);
  assert.equal(added.body.branch.name, 'TEST BRANCH');
  assert.equal((await admin('/api/admin/branches', create)).status, 409);
  assert.equal((await login(anonymous, added.body.branch.id, '6789')).status, 200);
  assert.equal((await admin(`/api/admin/branches/${branches[0].id}/pin`, { method: 'PUT', body: { pin: '5294' } })).status, 200);
  assert.equal((await read(staff, 'slots')).status, 401);
  assert.equal((await read(other, 'slots')).status, 200);
  assert.equal((await login(staff, branches[0].id)).status, 401);
  assert.equal((await login(staff, branches[0].id, '5294')).status, 200);
  assert.equal((await read(staff, 'slots')).body.totals.balance, 80_000);
  await staff('/api/logout', { method: 'POST', body: {} });
  assert.equal((await read(staff, 'slots')).status, 401);

  await app.stop();
  app = await listen(options);
  const afterRestart = client(app.origin);
  assert.equal((await login(afterRestart, branches[0].id, '5294')).status, 200);
  assert.equal((await read(afterRestart, 'live')).body.totals.tickets, 4);
  assert.equal((await read(afterRestart, 'live', '2028-03')).body.totals.openingBalance, -3_000);
  assert.equal((await afterRestart('/api/branches')).body.branches.length, 54);
});

test('closing balances carry across years, empty months and historical corrections', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-12-31T20:59:00Z') });
  const directory = await mkdtemp(join(tmpdir(), 'capitalbet-carry-'));
  const app = await listen({ local: true, filename: join(directory, 'database.sqlite') });
  t.after(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const staff = client(app.origin);
  const other = client(app.origin);
  const admin = client(app.origin);
  const [branch, otherBranch] = (await staff('/api/branches')).body.branches;
  assert.equal((await login(staff, branch.id)).status, 200);
  assert.equal((await login(other, otherBranch.id)).status, 200);
  assert.equal((await adminLogin(admin)).status, 200);

  const day = '2027-12-31';
  const previousSlots = { totalIn: 100_000, totalOut: 0, expenses: 0, cashIn: 0, cashOut: 0, freeCoupons: 0 };
  const balances = ({ openingBalance, monthlyMovement, balance }) => [openingBalance, monthlyMovement, balance];
  assert.equal((await save(staff, 'slots', previousSlots, 0, day)).status, 200);
  assert.equal((await save(staff, 'live', live, 0, day)).status, 200);
  assert.equal((await save(other, 'slots', { ...previousSlots, totalIn: 35_000 }, 0, day)).status, 200);
  assert.equal((await save(staff, 'slots', previousSlots, 1, day)).status, 200);
  t.mock.timers.tick(60_000);

  const january = await read(staff, 'slots', '2028-01');
  assert.deepEqual(january.body.records, []);
  assert.deepEqual(balances(january.body.totals), [100_000, 0, 100_000]);
  const saved = await save(staff, 'slots', { ...previousSlots, totalIn: 60_000, totalOut: 20_000 }, 0, '2028-01-01');
  assert.equal(saved.body.record.values.balance, 40_000);
  assert.deepEqual(saved.body.records, [saved.body.record]);
  assert.deepEqual(balances(saved.body.totals), [100_000, 40_000, 140_000]);
  assert.equal(saved.body.totals.totalIn, 60_000);
  assert.deepEqual(balances((await read(staff, 'slots', '2028-03')).body.totals), [140_000, 0, 140_000]);
  assert.deepEqual(balances((await read(staff, 'live', '2028-03')).body.totals), [-3_000, 0, -3_000]);
  assert.deepEqual(balances((await read(other, 'slots', '2028-03')).body.totals), [35_000, 0, 35_000]);

  const overview = (await admin('/api/admin/overview?month=2028-01')).body;
  const updates = `/api/admin/sales-updates?since=${overview.salesVersion}`;
  assert.equal((await staff(updates)).status, 403);
  const nextSales = admin(updates, { signal: AbortSignal.timeout(3000) });
  assert.deepEqual(balances(overview.totals.slots), [135_000, 40_000, 175_000]);
  assert.deepEqual(balances(overview.totals.live), [-3_000, 0, -3_000]);
  assert.deepEqual(balances(overview.branches.find(row => row.id === branch.id).slots), [100_000, 40_000, 140_000]);
  assert.deepEqual(overview.branches.find(row => row.id === branch.id).entriesByRegister, { slots: 1, live: 0 });
  assert.equal(overview.branches.find(row => row.id === otherBranch.id).entries, 0);

  const correction = { ...previousSlots, totalIn: 130_000 };
  const locked = await save(staff, 'slots', correction, 2, day);
  assert.equal(locked.status, 403);
  assert.match(locked.body.error, /locked/);
  assert.equal((await save(staff, 'slots', correction, 0, day)).status, 403);
  assert.equal((await save(staff, 'live', live, 1, day)).status, 403);
  assert.equal((await correct(staff, branch.id, 'slots', day, correction, 2)).status, 403);
  assert.equal((await correct(admin, branch.id, 'slots', day, correction, 1)).status, 409);
  const corrected = await correct(admin, branch.id, 'slots', day, correction, 2);
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.branch.id, branch.id);
  assert.equal(corrected.body.record.revision, 3);
  assert.notEqual(corrected.body.salesVersion, overview.salesVersion);
  assert.deepEqual((await nextSales).body, { salesVersion: corrected.body.salesVersion });
  const detail = (await admin(`/api/admin/branches/${branch.id}/slots?month=2028-03`)).body;
  assert.deepEqual(balances(detail.totals), [170_000, 0, 170_000]);
  assert.deepEqual(balances((await read(staff, 'slots', '2027-12')).body.totals), [0, 130_000, 130_000]);
  const blank = '2027-12-30';
  assert.equal((await correct(admin, branch.id, 'live', blank, live, 0)).status, 404);
  assert.equal((await save(staff, 'live', live, 0, blank)).status, 200);
  assert.equal((await save(staff, 'live', live, 1, blank)).status, 403);
});

test('production requires HTTPS and issues secure cookies using configured credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capitalbet-production-'));
  const options = { filename: join(directory, 'database.sqlite'), adminPassword: 'Unique-Admin-Password-fixture' };
  await assert.rejects(createApplication(options), /Configure TLS/);
  const app = await listen({ ...options, trustProxy: true, publicOrigin: 'https://capitalbet.test' });
  t.after(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const plain = client(app.origin);
  assert.equal((await plain('/api/status')).status, 403);
  const admin = client(app.origin, { 'X-Forwarded-Proto': 'https' });
  const staff = client(app.origin, { 'X-Forwarded-Proto': 'https' });
  const status = (await admin('/api/status')).body;
  assert.equal(status.pinLength, 6);
  assert.equal(Object.hasOwn(status, 'demo'), false);
  assert.equal((await adminLogin(admin)).status, 401);
  const signedIn = await adminLogin(admin, options.adminPassword);
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get('Set-Cookie'), /^__Host-capitalbet=.*; Secure$/);
  const [branch] = (await admin('/api/admin/branches')).body.branches;
  assert.equal(branch.pinSet, false);
  assert.equal((await login(staff, branch.id)).status, 401);
  const setPin = pin => admin(`/api/admin/branches/${branch.id}/pin`, { method: 'PUT', body: { pin } });
  assert.equal((await setPin('1234')).status, 400);
  assert.equal((await setPin('673519')).status, 200);
  assert.equal((await login(staff, branch.id, '673519')).status, 200);
});

test('Render health checks and forwarded HTTPS sign-in', async t => {
  const publicOrigin = 'https://capitalbet.onrender.com';
  const app = await listen({ filename: ':memory:', adminPassword: fixtureAdminPassword, renderProxy: true, publicOrigin });
  t.after(app.stop);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 204);

  const plain = client(app.origin, { 'X-Forwarded-Proto': 'https' });
  assert.equal((await plain('/api/status')).status, 403);
  const headers = { 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '203.0.113.42' };
  const admin = client(app.origin, { ...headers, Origin: publicOrigin });
  for (const path of ['/', '/admin/login']) {
    assert.equal((await fetch(`${app.origin}${path}`, { headers })).status, 200);
  }
  const loginResponse = await adminLogin(admin);
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get('Set-Cookie'), /^__Host-capitalbet=.*; Secure$/);
});

const testDatabase = process.env.CAPITALBET_TEST_DATABASE_URL;
test('Supabase schema, sales import, and PostgreSQL application storage', { skip: !testDatabase }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2028-02-29T20:59:00Z') });
  const database = new URL(testDatabase);
  assert.equal(database.hostname, '127.0.0.1');
  assert.equal(database.pathname, '/capitalbet_test');
  const poolOptions = { connectionString: testDatabase, connectionTimeoutMillis: 5000 };
  const setup = makePool(poolOptions);
  t.after(() => setup.end());
  const { rows: [state] } = await setup.query("SELECT to_regnamespace('capitalbet') AS existing_schema");
  assert.equal(state.existing_schema, null, 'Use a fresh disposable database.');
  await setup.query(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  await setup.query("INSERT INTO capitalbet.config (key, value) VALUES ('admin_user_id', 'fixture-admin')");

  const pinVault = createPinVault('ab'.repeat(32));
  const name = 'MIGRATED BRANCH FIXTURE';
  const pin = '678905';
  const { hash, cipher } = await pinVault.protect(name, pin);
  const snapshot = {
    branches: [{ id: 999, name, pin_hash: hash, pin_cipher: cipher }],
    entries: [{ branch_id: 999, kind: 'slots', day: '2028-01-31', amounts: JSON.stringify(slots), revision: 1 }],
  };
  const imported = await importSales(setup, snapshot, pinVault);
  assert.equal(imported.entries, 1);
  assert.deepEqual(await importSales(setup, snapshot, pinVault), imported);

  const pool = makePool(poolOptions);
  let app;
  t.after(() => app ? app.stop() : pool.end());
  const store = await openPostgresStore(pool, { notifyOnSave: true });
  assert.equal(store.adminUserId, 'fixture-admin');
  app = await listen({ local: true, store, pinVault, passwordRecovery: false,
    adminAuth: { signIn: async password => password === fixtureAdminPassword } });
  const staff = client(app.origin);
  const admin = client(app.origin);
  const { branches } = (await staff('/api/branches')).body;
  assert.equal(branches.length, imported.branches);
  const branch = branches.find(branch => branch.name === name);
  assert.ok(branch);
  assert.equal((await login(staff, branch.id, pin)).status, 200);
  assert.equal((await adminLogin(admin)).status, 200);
  assert.equal((await read(staff, 'slots')).body.totals.openingBalance, 80_000);
  const saves = await Promise.all([save(staff, 'live', live), save(staff, 'live', live)]);
  assert.deepEqual(saves.map(result => result.status).sort(), [200, 409]);
  const overview = (await admin(`/api/admin/overview?month=${month}`)).body;
  assert.equal(overview.totals.slots.balance, 80_000);
  assert.equal(overview.totals.live.balance, -3_000);
  assert.equal((await setup.query('SELECT count(*)::integer AS count FROM capitalbet.entries')).rows[0].count, 2);
  assert.equal(overview.salesVersion, '1');

  const origin = 'https://aloet256.github.io';
  const edgeApi = createApi({ store, pinVault, pinLength: 6, storage: 'supabase', dummyHash: hash, passwordRecovery: false,
    adminAuth: { signIn: async password => password === fixtureAdminPassword }, bearer: true });
  const handler = createEdgeHandler({ origin, getApi: async () => edgeApi });
  const request = (route, { method = 'GET', token, body, requester = origin } = {}) => handler(new Request(
    `https://project.supabase.co/functions/v1/capitalbet/api/${route}`, {
      method, headers: { Origin: requester, 'CF-Connecting-IP': '203.0.113.9', ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
    },
  ));
  const preflight = await request('login/staff', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await request('status', { requester: 'https://other.example' })).status, 403);
  const staffLogin = await request('login/staff', { method: 'POST', body: { branchId: branch.id, pin } });
  assert.equal(staffLogin.status, 200);
  assert.equal(staffLogin.headers.get('Set-Cookie'), null);
  const { token } = await staffLogin.json();
  assert.match(token, /^[\da-f]{64}$/);
  assert.equal((await request(`registers/live?month=${month}`, { token })).status, 200);
  assert.equal((await request(`admin/overview?month=${month}`, { token })).status, 403);
  t.mock.timers.tick(60_000);
  assert.equal((await request(`registers/live/${month}-29`, {
    method: 'PUT', token, body: { revision: 1, values: live },
  })).status, 403);
  assert.equal((await request('logout', { method: 'POST', token })).status, 200);
  assert.equal((await request(`registers/live?month=${month}`, { token })).status, 401);
  const hostedAdmin = await request('login/admin', { method: 'POST', body: { password: fixtureAdminPassword } });
  assert.equal(hostedAdmin.status, 200);
  const adminToken = (await hostedAdmin.json()).token;
  assert.equal((await request(`admin/overview?month=${month}`, { token: adminToken })).status, 200);

  const now = Date.now();
  const limit = await Promise.all(Array.from({ length: 4 }, () => store.takeAttempt('fixture-rate', 2, now, now + 1000)));
  assert.equal(limit.filter(Boolean).length, 2);
  await store.releaseAttempt('fixture-rate', limit.find(Boolean));
  assert.ok(await store.takeAttempt('fixture-rate', 2, now, now + 1000));

  const lease = crypto.randomUUID();
  const notification = await store.claimNotification(lease, now, now + 60_000);
  assert.deepEqual(notification.payload.balances, { slots: 80_000, live: -3_000 });
  await store.finishNotification(notification.id, lease, now + 1_000);
  const nextLease = crypto.randomUUID();
  assert.equal(await store.claimNotification(nextLease, now, now + 60_000), undefined);
  const retry = await store.claimNotification(nextLease, now + 1_000, now + 60_000);
  assert.equal(retry.attempts, 1);
  await store.finishNotification(retry.id, nextLease);
  const nextSales = store.watchSales(overview.salesVersion, AbortSignal.timeout(4000));
  for (;;) {
    const result = await setup.query("SELECT 1 FROM pg_stat_activity WHERE query = 'LISTEN capitalbet_sales' LIMIT 1");
    if (result.rowCount) break;
    await Promise.race([nextSales.then(() => { assert.fail('The PostgreSQL listener did not stay open'); }), new Promise(resolve => setTimeout(resolve, 20))]);
  }
  const correction = await request(`admin/branches/${branch.id}/live/${month}-29`, {
    method: 'PUT', token: adminToken, body: { revision: 1, values: { ...live, totalIn: 25_000 } },
  });
  assert.equal(correction.status, 200);
  const corrected = await correction.json();
  assert.equal(corrected.record.revision, 2);
  assert.equal(corrected.totals.balance, 7_000);
  assert.equal(await nextSales, corrected.salesVersion);
  assert.equal((await setup.query('SELECT count(*)::integer AS count FROM capitalbet.notifications')).rows[0].count, 0);
});

test('managed branch PINs are admin-only and a saved register queues a Telegram alert', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2028-02-29T20:59:00Z') });
  const earlier = Promise.withResolvers();
  const submitted = Promise.withResolvers();
  const edited = Promise.withResolvers();
  const deliveries = [earlier, submitted, edited];
  const app = await listen({
    local: true, filename: ':memory:', pinVault: createPinVault('ab'.repeat(32)), initialAdminPassword: 'Admin-password-fixture',
    telegram: {
      token: 'fixture-token', chatId: 'fixture-chat', interval: 25,
      fetcher: async (_url, options) => {
        deliveries.shift()?.resolve(JSON.parse(options.body));
        return Response.json({ ok: true });
      },
    },
  });
  t.after(() => app.stop());
  const admin = client(app.origin);
  const staff = client(app.origin);
  const [branch] = (await staff('/api/branches')).body.branches;
  const pinRoute = `/api/admin/branches/${branch.id}/pin`;
  assert.equal((await staff(pinRoute)).status, 401);
  assert.equal((await login(staff, branch.id)).status, 401);
  assert.equal((await adminLogin(admin, 'Admin-password-fixture')).status, 200);
  const { pin } = (await admin(pinRoute)).body;
  assert.match(pin, /^\d{6}$/);
  assert.equal((await login(staff, branch.id, pin)).status, 200);
  assert.equal((await staff(pinRoute)).status, 403);
  assert.equal((await save(staff, 'live', { ...live, totalIn: 19_000 }, 0, `${month}-28`)).status, 200);
  assert.equal((await save(staff, 'live', live)).status, 200);
  assert.equal((await save(staff, 'live', { ...live, totalIn: 25_000 }, 1)).status, 200);
  const [, firstAlert, secondAlert] = await Promise.race([Promise.all([earlier.promise, submitted.promise, edited.promise]), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Telegram alert was not delivered')), 1500);
    timer.unref();
  })]);
  assert.equal(firstAlert.chat_id, 'fixture-chat');
  assert.equal(firstAlert.parse_mode, 'HTML');
  assert.equal(firstAlert.text, [
    `🏪 <b>${branch.name.toUpperCase()}</b>`,
    '✅ Live-in-Play Entry submitted',
    '📅 Entry date · 29 February 2028',
    '💵 Cash at Hand: UGX -20',
  ].join('\n'));
  assert.match(secondAlert.text, /✏️ Live-in-Play Entry updated/);
  assert.match(secondAlert.text, /💵 Cash at Hand: UGX 80/);
  assert.equal((await admin(pinRoute, { method: 'PUT', body: {} })).status, 200);
  assert.equal((await read(staff, 'live')).status, 401);
  const replacement = (await admin(pinRoute)).body.pin;
  assert.match(replacement, /^\d{6}$/);
  assert.notEqual(replacement, pin);
  const added = await admin('/api/admin/branches', { method: 'POST', body: { name: 'Managed Branch Fixture' } });
  assert.equal(added.status, 201);
  assert.match((await admin(`/api/admin/branches/${added.body.branch.id}/pin`)).body.pin, /^\d{6}$/);
});

test('administrator password changes require a verified recovery code and revoke the old session', async t => {
  let password = 'Previous-password-fixture';
  let requested = 0;
  const app = await listen({ local: true, filename: ':memory:', adminAuth: {
    signIn: async input => input === password,
    sendCode: async () => { requested++; },
    verifyCode: async code => requested && code === '693014' ? { verified: true } : null,
    changePassword: async (grant, next) => { if (!grant.verified) return false; password = next; return true; },
  } });
  t.after(() => app.stop());
  const admin = client(app.origin);
  const recovery = client(app.origin);
  assert.equal((await adminLogin(admin, password)).status, 200);
  const post = (action, body) => recovery(`/api/admin/recovery/${action}`, { method: 'POST', body });
  const newPassword = 'Replacement-password-fixture';
  assert.equal((await post('reset', { password: newPassword })).status, 401);
  assert.equal((await post('request', {})).status, 200);
  assert.equal((await post('verify', { code: '999999' })).status, 400);
  assert.equal((await post('verify', { code: '693014' })).status, 200);
  assert.equal((await post('reset', { password: newPassword })).status, 200);
  assert.equal((await post('reset', { password: 'Unauthorised-fixture' })).status, 401);
  assert.equal((await admin('/api/admin/branches')).status, 401);
  assert.equal((await adminLogin(admin, 'Previous-password-fixture')).status, 401);
  assert.equal((await adminLogin(admin, newPassword)).status, 200);
});
