import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server.mjs';
import { createPinVault } from '../credentials.mjs';
import { daysInMonth } from '../public/sales.mjs';

async function listen(options) {
  const server = await createApplication(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function client(origin, defaults = {}) {
  let cookie;
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
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
const demoPassword = 'CapitalbetDemo!2026';
const login = (session, branchId, pin = '1234') => session('/api/login/staff', { method: 'POST', body: { branchId, pin } });
const adminLogin = (session, password = demoPassword) => session('/api/login/admin', { method: 'POST', body: { password } });
const read = (session, kind, period = month) => session(`/api/registers/${kind}?month=${period}`);
const save = (session, kind, values, revision = 0, day = `${month}-29`) => session(`/api/registers/${kind}/${day}`, { method: 'PUT', body: { revision, values } });

test('staff and administrator flows with persistent and isolated registers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capitalbet-demo-'));
  const options = { demo: true, filename: join(directory, 'database.sqlite') };
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
  const directory = await mkdtemp(join(tmpdir(), 'capitalbet-carry-'));
  const app = await listen({ demo: true, filename: join(directory, 'database.sqlite') });
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
  assert.deepEqual(balances(overview.totals.slots), [135_000, 40_000, 175_000]);
  assert.deepEqual(balances(overview.totals.live), [-3_000, 0, -3_000]);
  assert.deepEqual(balances(overview.branches.find(row => row.id === branch.id).slots), [100_000, 40_000, 140_000]);
  assert.deepEqual(overview.branches.find(row => row.id === branch.id).entriesByRegister, { slots: 1, live: 0 });
  assert.equal(overview.branches.find(row => row.id === otherBranch.id).entries, 0);

  assert.equal((await save(staff, 'slots', { ...previousSlots, totalIn: 130_000 }, 1, day)).status, 200);
  const detail = (await admin(`/api/admin/branches/${branch.id}/slots?month=2028-03`)).body;
  assert.deepEqual(balances(detail.totals), [170_000, 0, 170_000]);
  assert.deepEqual(balances((await read(staff, 'slots', '2027-12')).body.totals), [0, 130_000, 130_000]);
});

test('production requires HTTPS, has no demo PINs and issues secure cookies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'capitalbet-production-'));
  const options = { filename: join(directory, 'database.sqlite'), adminPassword: 'Unique-Admin-Password-fixture' };
  await assert.rejects(createApplication(options), /Configure TLS/);
  const app = await listen({ ...options, trustProxy: true, publicOrigin: 'https://capitalbet.test' });
  t.after(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const plain = client(app.origin);
  assert.equal((await plain('/api/status')).status, 403);
  const admin = client(app.origin, { 'X-Forwarded-Proto': 'https' });
  const staff = client(app.origin, { 'X-Forwarded-Proto': 'https' });
  assert.equal((await admin('/api/status')).body.demo, false);
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

test('managed branch PINs are admin-only and a saved register queues a Telegram alert', async t => {
  let deliver;
  const delivered = new Promise(resolve => { deliver = resolve; });
  const app = await listen({
    demo: true, filename: ':memory:', pinVault: createPinVault('ab'.repeat(32)), initialAdminPassword: 'Admin-password-fixture',
    telegram: {
      token: 'fixture-token', chatId: 'fixture-chat',
      fetcher: async (_url, options) => {
        deliver(JSON.parse(options.body));
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
  assert.equal((await save(staff, 'live', live)).status, 200);
  const alert = await Promise.race([delivered, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Telegram alert was not delivered')), 1500);
    timer.unref();
  })]);
  assert.equal(alert.chat_id, 'fixture-chat');
  assert.match(alert.text, new RegExp(`${branch.name} filled in Live-in-Play figures`));
  assert.match(alert.text, /Live-in-Play balance: UGX -30/);
  assert.equal((await admin(pinRoute, { method: 'PUT', body: {} })).status, 200);
  assert.equal((await read(staff, 'live')).status, 401);
  assert.match((await admin(pinRoute)).body.pin, /^\d{6}$/);
  const added = await admin('/api/admin/branches', { method: 'POST', body: { name: 'Managed Branch Fixture' } });
  assert.equal(added.status, 201);
  assert.match((await admin(`/api/admin/branches/${added.body.branch.id}/pin`)).body.pin, /^\d{6}$/);
});

test('administrator password changes require a verified recovery code and revoke the old session', async t => {
  let password = 'Previous-password-fixture';
  let requested = 0;
  const app = await listen({ demo: true, filename: ':memory:', adminAuth: {
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
