import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { digest, hashSecret, matches, randomPin } from './credentials.mjs';
import { daysInMonth, isRegister, registers, validMonth } from './public/sales.mjs';

const lifetime = 12 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireValue(condition, status, message) {
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

function validatedBranchName(input) {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ').toUpperCase() : '';
  requireValue(name.length >= 2 && name.length <= 90 && /[\p{L}\p{N}]/u.test(name) && !/[\p{Cc}\p{Cf}]/u.test(name), 400, 'Enter a branch name between 2 and 90 characters.');
  return name;
}

export function createApi({ store, adminAuth, pinVault, passwordRecovery, pinLength, storage, dummyHash,
  cookie = '', recoveryCookie = '', local = false, bearer = false, wake = () => {} }) {
  const attempts = new Map();
  const resetGrants = new Map();

  async function throttle(key, maximum) {
    const now = Date.now();
    const until = now + 15 * 60 * 1000;
    if (bearer) {
      const expiry = await store.takeAttempt(key, maximum, now, until);
      requireValue(expiry, 429, 'Too many attempts. Try again in 15 minutes.');
      return expiry;
    }
    for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
    const entry = attempts.get(key) ?? { tries: 0, until };
    requireValue(entry.tries < maximum, 429, 'Too many attempts. Try again in 15 minutes.');
    attempts.set(key, { ...entry, tries: entry.tries + 1 });
    return entry.until;
  }

  async function releaseAttempt(key, until) {
    if (bearer) return store.releaseAttempt(key, until);
    const entry = attempts.get(key);
    if (entry?.until !== until) return;
    if (entry?.tries === 1) attempts.delete(key);
    else if (entry) entry.tries--;
  }

  async function verifyAdminPassword(password, ip, incorrectStatus = 401) {
    requireValue(typeof password === 'string' && password.length > 0 && password.length <= 256, 400, 'Enter the administrator password.');
    const key = `admin:${ip}`;
    const expiry = await throttle(key, 10);
    const correct = adminAuth ? await adminAuth.signIn(password) : await matches(password, store.adminHash);
    requireValue(correct, incorrectStatus, 'The administrator password is incorrect.');
    await releaseAttempt(key, expiry);
  }

  function tokenHash(request, name = cookie) {
    if (bearer) {
      const token = /^Bearer ([\da-f]{64})$/i.exec(request.headers.authorization ?? '')?.[1];
      return token ? digest(token) : null;
    }
    const value = (request.headers.cookie ?? '').split(';').map(value => value.trim())
      .find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
    return /^[\da-f]{64}$/.test(value ?? '') ? digest(value) : null;
  }

  function sessionCookie(response, token, clear = false) {
    response.setHeader('Set-Cookie', `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict${local ? '' : '; Secure'}${clear ? '; Max-Age=0' : ''}`);
  }

  function resetCookie(response, token, maxAge) {
    response.setHeader('Set-Cookie', `${recoveryCookie}=${token}; Path=/; HttpOnly; SameSite=Strict${local ? '' : '; Secure'}; Max-Age=${maxAge}`);
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
    if (!bearer) sessionCookie(response, token);
    return { session: await store.session(digest(token)), ...(bearer ? { token } : {}) };
  }

  async function getBranch(id) {
    requireValue(Number.isInteger(Number(id)) && Number(id) > 0 && Number(id) <= 2_147_483_647, 404, 'Branch not found.');
    const branch = await store.branch(Number(id));
    requireValue(branch, 404, 'Branch not found.');
    return branch;
  }

  async function saveRegister(request, branchId, kind, day, role) {
    const month = day.slice(0, 7);
    requireValue(validMonth(month) && daysInMonth(month).includes(day), 400, 'Choose a valid date.');
    const data = await readJson(request);
    requireValue(Number.isSafeInteger(data.revision) && data.revision >= 0, 400, 'Refresh the register before saving.');
    const record = await store.saveEntry(branchId, kind, day, data.revision, validatedAmounts(kind, data.values), {
      sessionHash: tokenHash(request), role,
    });
    requireValue(record !== false, 401, 'Your session has ended. Sign in again.');
    requireValue(record !== 'locked', 403, 'This day’s entry is locked. Ask an administrator to correct it.');
    requireValue(record !== 'missing', 404, 'No entry has been saved for this day.');
    requireValue(record, 409, 'This entry changed in another session. Load the latest entry and try again.');
    if (role === 'staff') wake();
    return { record, ...await store.register(branchId, kind, month, { includeSalesVersion: role === 'admin' }) };
  }

  async function newPin(name, data, previous) {
    if (pinVault && (data.pin === undefined || data.pin === '')) return pinVault.protect(name, randomPin(previous));
    const rule = pinLength === 4 ? /^\d{4,12}$/ : /^\d{6,12}$/;
    requireValue(typeof data.pin === 'string' && rule.test(data.pin), 400, `Enter a PIN with ${pinLength} to 12 digits.`);
    requireValue(pinLength === 4 || data.pin !== '123456', 400, 'Choose a less predictable PIN.');
    requireValue(data.pin !== previous, 400, 'Enter a different staff PIN.');
    return pinVault ? pinVault.protect(name, data.pin) : { hash: await hashSecret(data.pin), cipher: null };
  }

  async function recover(request, response, action, ip) {
    requireValue(adminAuth && passwordRecovery, 503, 'Email recovery needs the Supabase recovery email setup.');
    const data = await readJson(request);
    if (action === 'request') {
      await throttle('admin-recovery-email', 3);
      await adminAuth.sendCode();
      return { sent: true };
    }
    if (bearer) {
      requireValue(action === 'reset', 404, 'Page not found.');
      requireValue(typeof data.code === 'string' && /^\d{6,10}$/.test(data.code), 400, 'Enter the code from the email.');
      requireValue(typeof data.password === 'string' && data.password.length >= 8 && data.password.length <= 256, 400, 'Enter a new password of 8 to 256 characters.');
      await throttle(`admin-recovery-verify:${ip}`, 10);
      const authorization = await adminAuth.verifyCode(data.code);
      requireValue(authorization, 400, 'The reset code is incorrect or expired.');
      requireValue(await adminAuth.changePassword(authorization, data.password), 400, 'Supabase did not accept the new password. Request a new reset code.');
      await store.revokeAdminSessions();
      return { updated: true };
    }
    if (action === 'verify') {
      requireValue(typeof data.code === 'string' && /^\d{6,10}$/.test(data.code), 400, 'Enter the code from the email.');
      await throttle(`admin-recovery-verify:${ip}`, 10);
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

  async function api(request, response, url, ip, signal) {
    const { pathname } = url;
    const method = request.method;
    if (method === 'GET' && pathname === '/api/status') return {
      pinLength,
      managedPins: Boolean(pinVault), branchChanges: true, passwordRecovery, storage,
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
      const clientExpiry = await throttle(clientKey, 40);
      const branchKey = `branch:${data.branchId}`;
      const branchExpiry = branch ? await throttle(branchKey, 12) : null;
      const valid = await matches(data.pin, branch?.pin_hash ?? dummyHash);
      requireValue(valid && branch?.pin_hash, 401, 'The branch or PIN is incorrect.');
      await releaseAttempt(clientKey, clientExpiry);
      await releaseAttempt(branchKey, branchExpiry);
      return login(request, response, 'staff', branch);
    }

    if (method === 'POST' && pathname === '/api/login/admin') {
      const data = await readJson(request);
      await verifyAdminPassword(data.password, ip);
      return login(request, response, 'admin');
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const token = tokenHash(request);
      if (token) await store.deleteSession(token);
      if (!bearer) sessionCookie(response, '', true);
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
        const session = await authorize(request, 'staff');
        return saveRegister(request, session.branch.id, kind, day, 'staff');
      }
    }

    if (pathname.startsWith('/api/admin/')) {
      await authorize(request, 'admin');
      if (method === 'GET' && pathname === '/api/admin/sales-updates') {
        const since = url.searchParams.get('since');
        requireValue(/^\d{1,19}$/.test(since ?? ''), 400, 'Choose a valid sales version.');
        return { salesVersion: await store.watchSales(since, signal) };
      }
      if (method === 'GET' && pathname === '/api/admin/overview') return store.overview(monthFrom(url));
      if (method === 'GET' && pathname === '/api/admin/branches') return { branches: await store.managedBranches() };
      if (method === 'POST' && pathname === '/api/admin/branches') {
        const data = await readJson(request);
        const name = validatedBranchName(data.name);
        const { hash, cipher } = await newPin(name, data);
        await authorize(request, 'admin');
        const branch = await store.createBranch(name, hash, cipher);
        requireValue(branch, 409, 'A branch with that name already exists.');
        response.statusCode = 201;
        return { branch };
      }
      const branchPath = pathname.match(/^\/api\/admin\/branches\/(\d+)$/);
      if (branchPath && (method === 'PUT' || method === 'DELETE')) {
        const data = await readJson(request);
        const branch = await getBranch(branchPath[1]);
        const stale = 'This branch changed. Refresh Branch Management and try again.';
        requireValue(data.currentName === branch.name, 409, stale);
        const name = method === 'PUT' ? validatedBranchName(data.name) : null;
        await verifyAdminPassword(data.password, ip, 403);
        await authorize(request, 'admin');
        if (method === 'DELETE') {
          requireValue(await store.deleteBranch(branch.id, branch.name), 409, stale);
          return { deleted: true };
        }
        const renamed = await store.renameBranch(branch.id, branch.name, name, current => {
          if (!current.pin_cipher) return current.pin_cipher;
          requireValue(pinVault, 503, 'Branch PIN management is temporarily unavailable.');
          return pinVault.rebind(current.name, name, current.pin_cipher);
        });
        requireValue(renamed !== false, 409, stale);
        requireValue(renamed, 409, 'A branch with that name already exists.');
        return { branch: renamed };
      }
      const branchRegister = pathname.match(/^\/api\/admin\/branches\/(\d+)\/(slots|live)(?:\/(\d{4}-\d{2}-\d{2}))?$/);
      if (branchRegister) {
        const [, id, kind, day] = branchRegister;
        if (method === 'GET' && !day) {
          const branch = await getBranch(id);
          return { branch: { id: branch.id, name: branch.name }, ...await store.register(branch.id, kind, monthFrom(url), { includeSalesVersion: true }) };
        }
        if (method === 'PUT' && day) {
          const branch = await getBranch(id);
          return { ...await saveRegister(request, branch.id, kind, day, 'admin'), branch: { id: branch.id, name: branch.name } };
        }
      }
      const pin = pathname.match(/^\/api\/admin\/branches\/(\d+)\/pin$/);
      if (method === 'GET' && pin) {
        const branch = await getBranch(pin[1]);
        requireValue(pinVault && branch.pin_cipher, 404, 'A viewable PIN has not been generated for this branch.');
        return { pin: pinVault.reveal(branch.name, branch.pin_cipher) };
      }
      if (method === 'PUT' && pin) {
        const branch = await getBranch(pin[1]);
        const previous = pinVault && branch.pin_cipher ? pinVault.reveal(branch.name, branch.pin_cipher) : undefined;
        const { hash, cipher } = await newPin(branch.name, await readJson(request), previous);
        await authorize(request, 'admin');
        requireValue(await store.changePin(branch.id, branch.name, hash, cipher), 409, 'This branch changed. Refresh Branch Management and try again.');
        return { updated: true };
      }
    }
    throw new HttpError(404, 'Page not found.');
  }

  return api;
}
