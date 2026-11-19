import { createAdminAuth } from '../../../admin-recovery.mjs';
import { createApi } from '../../../api.mjs';
import { createPinVault, hashSecret } from '../../../credentials.mjs';
import { createEdgeHandler } from '../../../edge.mjs';
import { makePool, openPostgresStore } from '../../../postgres-store.mjs';
import { deliverTelegram } from '../../../telegram.mjs';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const origin = Deno.env.get('CAPITALBET_SITE_ORIGIN') ?? 'https://aloet256.github.io';
const telegram = { token: Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '', chatId: Deno.env.get('TELEGRAM_CHAT_ID') ?? '' };
const notificationsEnabled = Boolean(telegram.token && telegram.chatId);
const pool = makePool({ connectionString: Deno.env.get('SUPABASE_DB_URL'), max: 1, connectionTimeoutMillis: 8000, idleTimeoutMillis: 3000 });
let application: ReturnType<typeof initialize> | undefined;

async function initialize() {
  const pinVault = createPinVault(Deno.env.get('CAPITALBET_PIN_KEY'));
  if (!pinVault) throw new Error('Capitalbet PIN encryption is missing.');
  const store = await openPostgresStore(pool, { notifyOnSave: notificationsEnabled });
  const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const adminAuth = createAdminAuth({
    url: Deno.env.get('SUPABASE_URL'), publishableKey: keys.default ?? Deno.env.get('SUPABASE_ANON_KEY'),
    email: Deno.env.get('CAPITALBET_ADMIN_EMAIL'), userId: store.adminUserId,
  });
  const sendNotifications = () => deliverTelegram(store, telegram, { limit: 4 });
  const wake = () => {
    if (notificationsEnabled) EdgeRuntime.waitUntil(sendNotifications().catch(() => console.warn('The Telegram outbox is temporarily unavailable.')));
  };
  const api = createApi({ store, adminAuth, pinVault, passwordRecovery: store.recoveryReady || Deno.env.get('CAPITALBET_RECOVERY_READY') === '1',
    pinLength: 6, storage: 'supabase', dummyHash: await hashSecret(crypto.randomUUID()), bearer: true, wake });
  return { api, sendNotifications };
}

function getApplication() {
  application ??= initialize().catch(error => {
    application = undefined;
    throw error;
  });
  return application;
}

Deno.serve(createEdgeHandler({
  origin,
  getApi: async () => (await getApplication()).api,
  cronSecret: Deno.env.get('CAPITALBET_CRON_SECRET'),
  sendNotifications: async () => (await getApplication()).sendNotifications(),
}));
