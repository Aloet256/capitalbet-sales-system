import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdminAuth } from './admin-recovery.mjs';
import { loadConfig, postgresOptions } from './config.mjs';
import { createPinVault, digest, hashSecret, matches } from './credentials.mjs';
import { openStore } from './database.mjs';
import { makePool, openPostgresStore } from './postgres-store.mjs';
import { startTelegramWorker } from './telegram.mjs';
import { daysInMonth, isRegister, registers, validMonth } from './public/sales.mjs';

const lifetime = 12 * 60 * 60 * 1000;
const demoPassword = 'CapitalbetDemo!2026';
const loopbacks = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export { hashSecret } from './credentials.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

async function readJson(request) {
  requireValue(/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''), 415, 'Send JSON data.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'The request contains invalid JSON.');
  }
}

function monthFrom(url) {
  const month = url.searchParams.get('month');
  requireValue(validMonth(month), 400, 'Choose a valid month and year.');
  return month;
}

function validatedAmounts(kind, values) {
  requireValue(values && typeof values === 'object' && !Array.isArray(values), 400, 'Enter the sales amounts.');
  return Object.fromEntries(registers[kind].fields.map(([key, label]) => {
    const value = values[key];
    const limit = key === 'tickets' ? 1_000_000_000 : 99_999_999_999;
    requireValue(Number.isSafeInteger(value) && value >= 0 && value <= limit, 400, `Enter a valid value for ${label}.`);
    return [key, value];
  }));
}

const staticFiles = new Map(Object.entries({
  '/app.mjs': 'text/javascript; charset=utf-8',
  '/sales.mjs': 'text/javascript; charset=utf-8',
  '/ui.mjs': 'text/javascript; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
  '/capitalbet-logo.png': 'image/png',
}));
const pages = new Set(['/', '/dashboard', '/slots', '/live', '/admin', '/admin/login', '/admin/forgot-password', '/admin/branches']);

export async function createApplication({ filename, demo = false, adminPassword, initialAdminPassword, tls, trustProxy = false,
  publicOrigin, store: configuredStore, pinVault, adminAuth, telegram } = {}) {
  if (!configuredStore && !demo && adminPassword && (adminPassword.length < 14 || adminPassword.length > 256 || adminPassword === demoPassword)) {
    throw new Error('Choose a unique production administrator password with 14 to 256 characters.');
  }
  if (!demo && !tls && (!trustProxy || !publicOrigin?.startsWith('https://'))) {
    throw new Error('Configure TLS or a loopback reverse proxy with a CAPITALBET_PUBLIC_ORIGIN HTTPS URL.');
  }
  const [adminHash, demoPinHash, dummyHash] = await Promise.all([
    !configuredStore && (demo || adminPassword) ? hashSecret(demo ? demoPassword : adminPassword) : null,
    !configuredStore && demo ? hashSecret('1234') : null,
    hashSecret(randomBytes(20).toString('hex')),
  ]);
  const notifyOnSave = Boolean(telegram?.token && telegram?.chatId);
  const store = configuredStore ?? openStore(filename ?? resolve('data', demo ? 'demo.sqlite' : 'production.sqlite'), { demo, adminHash, demoPinHash, notifyOnSave });
  if (!configuredStore && initialAdminPassword && pinVault) store.initializeAdmin(await hashSecret(initialAdminPassword));
  if (!configuredStore && pinVault) {
    const protections = await Promise.all(store.unsealedBranches().map(async branch => ({ id: branch.id, ...await pinVault.protect(branch.name) })));
    store.initializePins(protections);
  }
  const delivery = startTelegramWorker(store, telegram);
  const pinLength = demo && !pinVault ? 4 : 6;
  const cookie = !demo ? '__Host-capitalbet' : configuredStore ? 'capitalbet_cloud_preview' : 'capitalbet_demo';
  const recoveryCookie = demo ? 'capitalbet_recovery' : '__Host-capitalbet-recovery';
  const attempts = new Map();
  const resetGrants = new Map();

  function throttle(key, maximum) {
    const now = Date.now();
    for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
    const entry = attempts.get(key) ?? { tries: 0, until: now + 15 * 60 * 1000 };
    requireValue(entry.tries < maximum, 429, 'Too many attempts. Try again in 15 minutes.');
    attempts.set(key, { ...entry, tries: entry.tries + 1 });
  }

  function releaseAttempt(key) {
    const entry = attempts.get(key);
    if (entry?.tries === 1) attempts.delete(key);
    else if (entry) entry.tries--;
  }

  function tokenHash(request, name = cookie) {
    const value = (request.headers.cookie ?? '').split(';').map(value => value.trim())
      .find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
    return /^[\da-f]{64}$/.test(value ?? '') ? digest(value) : null;
  }

  function sessionCookie(response, token, clear = false) {
    response.setHeader('Set-Cookie', `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict${demo ? '' : '; Secure'}${clear ? '; Max-Age=0' : ''}`);
  }

  function resetCookie(response, token, maxAge) {
    response.setHeader('Set-Cookie', `${recoveryCookie}=${token}; Path=/; HttpOnly; SameSite=Strict${demo ? '' : '; Secure'}; Max-Age=${maxAge}`);
  }

  function sessionFor(request) {
    const token = tokenHash(request);
    return token ? store.session(token) : null;
  }

  async function authorize(request, role) {
    const session = await sessionFor(request);
    requireValue(session, 401, 'Your session has ended. Sign in again.');
    requireValue(session.role === role, 403, 'This page requires a different sign-in.');
    return session;
  }

  async function login(request, response, role, branch) {
    const token = randomBytes(32).toString('hex');
    requireValue(await store.createSession(digest(token), role, branch, Date.now() + lifetime, branch?.pin_hash), 401, 'The branch PIN changed. Sign in again.');
    const old = tokenHash(request);
    if (old) await store.deleteSession(old);
    sessionCookie(response, token);
    return store.session(digest(token));
  }

  async function getBranch(id) {
    requireValue(Number.isInteger(Number(id)) && Number(id) > 0 && Number(id) <= 2_147_483_647, 404, 'Branch not found.');
    const branch = await store.branch(Number(id));
    requireValue(branch, 404, 'Branch not found.');
    return branch;
  }

  async function newPin(name, data) {
    if (pinVault && (data.pin === undefined || data.pin === '')) return pinVault.protect(name);
    const rule = pinLength === 4 ? /^\d{4,12}$/ : /^\d{6,12}$/;
    requireValue(typeof data.pin === 'string' && rule.test(data.pin), 400, `Enter a PIN with ${pinLength} to 12 digits.`);
    requireValue(pinLength === 4 || data.pin !== '123456', 400, 'Choose a less predictable PIN.');
    return pinVault ? pinVault.protect(name, data.pin) : { hash: await hashSecret(data.pin), cipher: null };
  }

  async function recover(request, response, action, ip) {
    requireValue(adminAuth, 503, 'Email recovery needs the Supabase administrator connection.');
    const data = await readJson(request);
    if (action === 'request') {
      throttle('admin-recovery-email', 3);
      await adminAuth.sendCode();
      return { sent: true };
    }
    if (action === 'verify') {
      requireValue(typeof data.code === 'string' && /^\d{6,10}$/.test(data.code), 400, 'Enter the code from the email.');
      throttle(`admin-recovery-verify:${ip}`, 10);
      const authorization = await adminAuth.verifyCode(data.code);
      requireValue(authorization, 400, 'The reset code is incorrect or expired.');
      const now = Date.now();
      const token = randomBytes(32).toString('hex');
      const old = tokenHash(request, recoveryCookie);
      for (const [hash, grant] of resetGrants) if (grant.until <= now || hash === old) resetGrants.delete(hash);
      resetGrants.set(digest(token), { authorization, until: now + 600_000 });
      resetCookie(response, token, 600);
      return { verified: true };
    }
    const token = tokenHash(request, recoveryCookie);
    const grant = resetGrants.get(token);
    requireValue(grant && grant.until > Date.now() && !grant.pending, 401, 'Verify a new email code before changing the password.');
    requireValue(typeof data.password === 'string' && data.password.length >= 8 && data.password.length <= 256, 400, 'Enter a new password of 8 to 256 characters.');
    grant.pending = true;
    try {
      requireValue(await adminAuth.changePassword(grant.authorization, data.password), 400, 'Supabase did not accept the new password. Choose another password or request another code.');
      resetGrants.delete(token);
      resetCookie(response, '', 0);
      await store.revokeAdminSessions();
      return { updated: true };
    } finally {
      grant.pending = false;
    }
  }

  async function api(request, response, url, ip) {
    const { pathname } = url;
    const method = request.method;
    if (method === 'GET' && pathname === '/api/status') return {
      demo, pinLength, demoCredentials: demo && !pinVault && !adminAuth,
      managedPins: Boolean(pinVault), passwordRecovery: Boolean(adminAuth), storage: configuredStore ? 'supabase' : 'sqlite',
    };
    if (method === 'GET' && pathname === '/api/branches') return { branches: await store.branches() };
    if (method === 'GET' && pathname === '/api/session') return { session: await sessionFor(request) };
    const recovery = pathname.match(/^\/api\/admin\/recovery\/(request|verify|reset)$/);
    if (method === 'POST' && recovery) return recover(request, response, recovery[1], ip);

    if (method === 'POST' && pathname === '/api/login/staff') {
      const data = await readJson(request);
      requireValue(Number.isInteger(data.branchId) && data.branchId > 0 && data.branchId <= 2_147_483_647 && typeof data.pin === 'string' && /^\d{4,12}$/.test(data.pin), 400, 'Select a branch and enter its PIN.');
      const branch = await store.branch(data.branchId);
      const clientKey = `staff-ip:${ip}`;
      throttle(clientKey, 40);
      const branchKey = `branch:${data.branchId}`;
      if (branch) throttle(branchKey, 12);
      const valid = await matches(data.pin, branch?.pin_hash ?? dummyHash);
      requireValue(valid && branch?.pin_hash, 401, 'The branch or PIN is incorrect.');
      releaseAttempt(clientKey);
      releaseAttempt(branchKey);
      return { session: await login(request, response, 'staff', branch) };
    }

    if (method === 'POST' && pathname === '/api/login/admin') {
      const data = await readJson(request);
      requireValue(typeof data.password === 'string' && data.password.length > 0 && data.password.length <= 256, 400, 'Enter the administrator password.');
      const key = `admin:${ip}`;
      throttle(key, 10);
      const correct = adminAuth ? await adminAuth.signIn(data.password) : await matches(data.password, store.adminHash);
      requireValue(correct, 401, 'The administrator password is incorrect.');
      releaseAttempt(key);
      return { session: await login(request, response, 'admin') };
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const token = tokenHash(request);
      if (token) await store.deleteSession(token);
      sessionCookie(response, '', true);
      return { session: null };
    }

    const register = pathname.match(/^\/api\/registers\/([a-z]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/);
    if (register && isRegister(register[1])) {
      const [, kind, day] = register;
      if (method === 'GET' && !day) {
        const session = await authorize(request, 'staff');
        return store.register(session.branch.id, kind, monthFrom(url));
      }
      if (method === 'PUT' && day) {
        await authorize(request, 'staff');
        const month = day.slice(0, 7);
        requireValue(validMonth(month) && daysInMonth(month).includes(day), 400, 'Choose a valid date.');
        const data = await readJson(request);
        const session = await authorize(request, 'staff');
        requireValue(Number.isSafeInteger(data.revision) && data.revision >= 0, 400, 'Refresh the register before saving.');
        const record = await store.saveEntry(session.branch.id, kind, day, data.revision, validatedAmounts(kind, data.values), tokenHash(request));
        requireValue(record !== false, 401, 'Your session has ended. Sign in again.');
        requireValue(record, 409, 'This entry changed in another session. Load the latest entry and try again.');
        delivery.wake();
        return { record, ...await store.register(session.branch.id, kind, month) };
      }
    }

    if (pathname.startsWith('/api/admin/')) {
      await authorize(request, 'admin');
      if (method === 'GET' && pathname === '/api/admin/overview') return store.overview(monthFrom(url));
      if (method === 'GET' && pathname === '/api/admin/branches') return { branches: await store.managedBranches() };
      if (method === 'POST' && pathname === '/api/admin/branches') {
        const data = await readJson(request);
        const name = typeof data.name === 'string' ? data.name.trim().replace(/\s+/g, ' ').toUpperCase() : '';
        requireValue(name.length >= 2 && name.length <= 90 && /[\p{L}\p{N}]/u.test(name) && !/[\p{Cc}\p{Cf}]/u.test(name), 400, 'Enter a branch name between 2 and 90 characters.');
        const { hash, cipher } = await newPin(name, data);
        await authorize(request, 'admin');
        const branch = await store.createBranch(name, hash, cipher);
        requireValue(branch, 409, 'A branch with that name already exists.');
        response.statusCode = 201;
        return { branch };
      }
      const branchRegister = pathname.match(/^\/api\/admin\/branches\/(\d+)\/(slots|live)$/);
      if (method === 'GET' && branchRegister) {
        const branch = await getBranch(branchRegister[1]);
        return { branch: { id: branch.id, name: branch.name }, ...await store.register(branch.id, branchRegister[2], monthFrom(url)) };
      }
      const pin = pathname.match(/^\/api\/admin\/branches\/(\d+)\/pin$/);
      if (method === 'GET' && pin) {
        const branch = await getBranch(pin[1]);
        requireValue(pinVault && branch.pin_cipher, 404, 'A viewable PIN has not been generated for this branch.');
        return { pin: pinVault.reveal(branch.name, branch.pin_cipher) };
      }
      if (method === 'PUT' && pin) {
        const branch = await getBranch(pin[1]);
        const { hash, cipher } = await newPin(branch.name, await readJson(request));
        await authorize(request, 'admin');
        await store.changePin(branch.id, hash, cipher);
        return { updated: true };
      }
    }
    throw new HttpError(404, 'Page not found.');
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const remote = request.socket.remoteAddress;
      const proxy = trustProxy && loopbacks.has(remote) && request.headers['x-forwarded-proto'] === 'https';
      const encrypted = request.socket.encrypted || proxy;
      requireValue(demo ? loopbacks.has(remote) : encrypted, 403, demo ? 'Use the demo on this computer.' : 'HTTPS is required.');
      if (!demo) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const origin = publicOrigin ?? `${encrypted ? 'https' : 'http'}://${request.headers.host}`;
      const url = new URL(request.url, origin);
      requireValue(!demo || ['127.0.0.1', 'localhost'].includes(url.hostname), 403, 'Open the demo from localhost.');
      const method = request.method;
      if (method !== 'GET' && method !== 'HEAD') {
        requireValue(request.headers['sec-fetch-site'] !== 'cross-site' && (!request.headers.origin || request.headers.origin === origin), 403, 'Use this application to submit changes.');
      }
      if (url.pathname.startsWith('/api/')) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        const forwarded = proxy ? request.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
        const data = await api(request, response, url, forwarded || remote);
        return response.end(JSON.stringify(data));
      }
      requireValue(method === 'GET' || method === 'HEAD', 405, 'Method not allowed.');
      const contentType = staticFiles.get(url.pathname);
      const knownPage = pages.has(url.pathname) || /^\/admin\/branches\/\d+(?:\/(?:slots|live))?$/.test(url.pathname);
      if (!contentType && !knownPage) response.statusCode = 404;
      const asset = contentType ? url.pathname.slice(1) : 'index.html';
      response.setHeader('Content-Type', contentType ?? 'text/html; charset=utf-8');
      return response.end(method === 'HEAD' ? undefined : readFileSync(new URL(`./public/${asset}`, import.meta.url)));
    } catch (error) {
      if (response.destroyed) return;
      if (!(error instanceof HttpError)) console.error(error);
      response.statusCode = error.status ?? 500;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: error.status ? error.message : 'The server could not complete your request.' }));
    }
  }

  const server = tls ? createSecureServer(tls, handle) : createServer(handle);
  server.on('close', () => Promise.resolve(delivery.stop()).then(() => store.close()).catch(() => console.error('Database close did not complete.')));
  return server;
}

async function main() {
  const env = loadConfig();
  const localStore = process.argv.includes('--demo');
  const demo = localStore || process.argv.includes('--local');
  const cloud = !localStore && (process.argv.includes('--supabase') || Boolean(env.DATABASE_URL));
  const { CAPITALBET_TLS_CERT, CAPITALBET_TLS_KEY, CAPITALBET_ADMIN_PASSWORD, CAPITALBET_DB,
    CAPITALBET_PUBLIC_ORIGIN, CAPITALBET_TRUST_PROXY, CAPITALBET_PORT } = env;
  const tls = CAPITALBET_TLS_CERT && CAPITALBET_TLS_KEY ? {
    cert: readFileSync(CAPITALBET_TLS_CERT), key: readFileSync(CAPITALBET_TLS_KEY),
  } : undefined;
  const pinVault = createPinVault(env.CAPITALBET_PIN_KEY);
  const telegram = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  if (cloud && !pinVault) throw new Error('Set CAPITALBET_PIN_KEY before starting with Supabase.');
  const pool = cloud ? makePool(postgresOptions(env)) : null;
  let server;
  try {
    const store = pool ? await openPostgresStore(pool, { notifyOnSave: Boolean(telegram.token && telegram.chatId) }) : undefined;
    const adminAuth = store ? createAdminAuth({ url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      email: env.CAPITALBET_ADMIN_EMAIL, userId: store.adminUserId }) : undefined;
    server = await createApplication({
      demo, tls, adminPassword: CAPITALBET_ADMIN_PASSWORD, filename: CAPITALBET_DB, store, adminAuth, pinVault, telegram,
      initialAdminPassword: env.CAPITALBET_INITIAL_ADMIN_PASSWORD,
      publicOrigin: CAPITALBET_PUBLIC_ORIGIN, trustProxy: CAPITALBET_TRUST_PROXY === '1',
    });
  } catch (error) {
    await pool?.end();
    throw error;
  }
  const port = Number(CAPITALBET_PORT ?? 3000);
  server.listen(port, '127.0.0.1', () => {
    console.log(`Capitalbet ${demo ? 'demo' : 'production'} running at ${CAPITALBET_PUBLIC_ORIGIN ?? `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`}`);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.code && !['ENOENT', 'EACCES'].includes(error.code) ? `Capitalbet could not start (${error.code}). Check the database settings.` : error.message);
    process.exitCode = 1;
  });
}
