import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdminAuth } from './admin-recovery.mjs';
import { createApi, HttpError, requireValue } from './api.mjs';
import { loadConfig, postgresOptions } from './config.mjs';
import { createPinVault, hashSecret } from './credentials.mjs';
import { openStore } from './database.mjs';
import { makePool, openPostgresStore } from './postgres-store.mjs';
import { startTelegramWorker } from './telegram.mjs';

const loopbacks = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export { hashSecret } from './credentials.mjs';

const staticFiles = new Map(Object.entries({
  '/app.mjs': 'text/javascript; charset=utf-8',
  '/sales.mjs': 'text/javascript; charset=utf-8',
  '/ui.mjs': 'text/javascript; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
  '/capitalbet-logo.png': 'image/png',
}));
const pages = new Set(['/', '/dashboard', '/slots', '/live', '/admin', '/admin/login', '/admin/forgot-password', '/admin/branches']);

export async function createApplication({ filename, local = false, adminPassword, initialAdminPassword, initialBranchPin, tls, trustProxy = false,
  proxyIps = [], renderProxy = false, publicOrigin, store: configuredStore, pinVault, adminAuth, passwordRecovery = Boolean(adminAuth), telegram } = {}) {
  if (!configuredStore && !local && adminPassword && (adminPassword.length < 14 || adminPassword.length > 256)) {
    throw new Error('Choose a unique production administrator password with 14 to 256 characters.');
  }
  if (publicOrigin) {
    const canonical = new URL(publicOrigin);
    if (canonical.protocol !== 'https:' || canonical.origin !== publicOrigin || canonical.username || canonical.password) {
      throw new Error('CAPITALBET_PUBLIC_ORIGIN must be an HTTPS origin with no path or credentials.');
    }
  }
  if (!local && !tls && (!(trustProxy || renderProxy) || !publicOrigin)) {
    throw new Error('Configure TLS or a trusted reverse proxy with a public HTTPS origin.');
  }
  const adminSeed = local ? initialAdminPassword ?? adminPassword : adminPassword;
  const [adminHash, initialPinHash, dummyHash] = await Promise.all([
    !configuredStore && adminSeed ? hashSecret(adminSeed) : null,
    !configuredStore && local && initialBranchPin ? hashSecret(initialBranchPin) : null,
    hashSecret(randomBytes(20).toString('hex')),
  ]);
  const notifyOnSave = Boolean(telegram?.token && telegram?.chatId);
  const store = configuredStore ?? openStore(filename ?? resolve('data', local ? 'demo.sqlite' : 'production.sqlite'), { local, adminHash, initialPinHash, notifyOnSave });
  if (!configuredStore && local && initialAdminPassword && pinVault) store.initializeAdmin(adminHash);
  if (!configuredStore && pinVault) {
    const protections = await Promise.all(store.unsealedBranches().map(async branch => ({ id: branch.id, ...await pinVault.protect(branch.name) })));
    store.initializePins(protections);
  }
  const delivery = startTelegramWorker(store, telegram);
  const pinLength = initialPinHash && !pinVault ? 4 : 6;
  const cookie = !local ? '__Host-capitalbet' : configuredStore ? 'capitalbet_cloud_preview' : 'capitalbet_local';
  const recoveryCookie = local ? 'capitalbet_recovery' : '__Host-capitalbet-recovery';
  const proxyAddresses = new Set([...loopbacks, ...proxyIps]);
  const api = createApi({ store, adminAuth, pinVault, passwordRecovery, pinLength, dummyHash, cookie, recoveryCookie, local,
    storage: configuredStore ? 'supabase' : 'sqlite', wake: delivery.wake });

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const method = request.method;
      // Render's internal health probe can arrive directly over HTTP.
      if (renderProxy && request.url === '/healthz' && (method === 'GET' || method === 'HEAD')) {
        response.statusCode = 204;
        return response.end();
      }
      const remote = request.socket.remoteAddress;
      const forwardedHttps = request.headers['x-forwarded-proto'] === 'https';
      const proxy = forwardedHttps && trustProxy && (proxyAddresses.has(remote) || proxyAddresses.has(remote?.replace(/^::ffff:/, '')));
      // Render's public edge overwrites CF-Connecting-IP with the caller's address.
      const edgeAddress = request.headers['cf-connecting-ip'] ?? '';
      const renderEdge = renderProxy && forwardedHttps && isIP(edgeAddress) !== 0;
      const encrypted = request.socket.encrypted || proxy || renderEdge;
      requireValue(local ? loopbacks.has(remote) : encrypted, 403, local ? 'This instance is available on its own computer.' : 'HTTPS is required.');
      if (!local) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const origin = publicOrigin ?? `${encrypted ? 'https' : 'http'}://${request.headers.host}`;
      const url = new URL(request.url, origin);
      requireValue(!local || ['127.0.0.1', 'localhost'].includes(url.hostname), 403, 'Open this instance from localhost.');
      if (method !== 'GET' && method !== 'HEAD') {
        requireValue(request.headers['sec-fetch-site'] !== 'cross-site' && (!request.headers.origin || request.headers.origin === origin), 403, 'Use this application to submit changes.');
      }
      if (url.pathname.startsWith('/api/')) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (url.pathname === '/api/admin/sales-updates') {
          const connection = new AbortController();
          response.once('close', () => connection.abort());
          request.signal = connection.signal;
        }
        const forwarded = proxy ? request.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
        const clientAddress = renderEdge ? edgeAddress : forwarded || remote;
        const data = await api(request, response, url, clientAddress);
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
  const local = process.argv.includes('--local');
  const cloud = !local || process.argv.includes('--supabase');
  const { CAPITALBET_TLS_CERT, CAPITALBET_TLS_KEY, CAPITALBET_DB,
    CAPITALBET_PUBLIC_ORIGIN, CAPITALBET_TRUST_PROXY, CAPITALBET_PORT } = env;
  const renderProxy = !local && env.RENDER === 'true' && Boolean(env.RENDER_EXTERNAL_URL);
  const publicOrigin = local ? undefined : CAPITALBET_PUBLIC_ORIGIN ?? (renderProxy ? env.RENDER_EXTERNAL_URL : undefined);
  const tls = CAPITALBET_TLS_CERT && CAPITALBET_TLS_KEY ? {
    cert: readFileSync(CAPITALBET_TLS_CERT), key: readFileSync(CAPITALBET_TLS_KEY),
  } : undefined;
  const pinVault = createPinVault(env.CAPITALBET_PIN_KEY);
  const telegram = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  if (!pinVault) throw new Error('Set CAPITALBET_PIN_KEY in the private configuration before starting Capitalbet.');
  const pool = cloud ? makePool(postgresOptions(env)) : null;
  let server;
  try {
    const store = pool ? await openPostgresStore(pool, { notifyOnSave: Boolean(telegram.token && telegram.chatId) }) : undefined;
    const adminAuth = store ? createAdminAuth({ url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      email: env.CAPITALBET_ADMIN_EMAIL, userId: store.adminUserId }) : undefined;
    server = await createApplication({
      local, tls, filename: CAPITALBET_DB, store, adminAuth, pinVault, telegram,
      initialAdminPassword: env.CAPITALBET_INITIAL_ADMIN_PASSWORD,
      passwordRecovery: Boolean(store && (store.recoveryReady || env.CAPITALBET_RECOVERY_READY === '1')),
      publicOrigin, renderProxy, trustProxy: CAPITALBET_TRUST_PROXY === '1',
      proxyIps: env.CAPITALBET_PROXY_IPS?.split(',').map(address => address.trim()).filter(Boolean),
    });
  } catch (error) {
    await pool?.end();
    throw error;
  }
  const port = Number(local ? CAPITALBET_PORT ?? 3000 : env.PORT ?? CAPITALBET_PORT ?? 3000);
  const bind = local ? '127.0.0.1' : env.CAPITALBET_BIND ?? (env.PORT ? '0.0.0.0' : '127.0.0.1');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Set a valid port for Capitalbet.');
  server.listen(port, bind, () => {
    const address = publicOrigin ?? `${tls ? 'https' : 'http'}://${bind}:${server.address().port}`;
    console.log(`Capitalbet listening at ${address}`);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.code && !['ENOENT', 'EACCES'].includes(error.code) ? `Capitalbet could not start (${error.code}). Check the database settings.` : error.message);
    process.exitCode = 1;
  });
}
