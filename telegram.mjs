import { randomUUID } from 'node:crypto';
import { registers } from './public/sales.mjs';
import { dateName, money } from './public/ui.mjs';

export function salesMessage({ branch, day, kind, balances, movement, updated }) {
  const action = updated === undefined ? 'saved' : updated ? 'updated' : 'submitted';
  return [
    `${branch} · ${registers[kind].title} entry ${action}`,
    `Entry date · ${dateName(day)}`,
    ...(movement === undefined ? [] : [`Daily movement · ${money(movement)}`]),
    '',
    'Running balances through the entry date',
    `Slots · ${money(balances.slots ?? 0)}`,
    `Live-in-Play · ${money(balances.live ?? 0)}`,
  ].join('\n');
}

export async function deliverTelegram(store, { token = '', chatId = '', fetcher = fetch, onError = console.warn } = {},
  { limit = Infinity, isStopped = () => false } = {}) {
  if (!token || !chatId) return;
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  for (let count = 0; count < limit && !isStopped(); count++) {
    const now = Date.now();
    const lease = randomUUID();
    const job = await store.claimNotification(lease, now, now + 60_000);
    if (!job) return;
    let retryAfter = 0;
    try {
      const result = await fetcher(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: salesMessage(job.payload) }),
        signal: AbortSignal.timeout(10_000),
      });
      const answer = await result.json();
      if (!result.ok || answer.ok !== true) {
        retryAfter = Number(answer.parameters?.retry_after ?? 0) * 1000;
        throw new Error(`Telegram returned HTTP ${result.status}.`);
      }
    } catch {
      const delay = Math.max(retryAfter || 0, Math.min(3_600_000, 5_000 * 2 ** Math.min(job.attempts, 10)));
      await store.finishNotification(job.id, lease, Date.now() + delay);
      onError('A Telegram alert is pending retry.');
      continue;
    }
    await store.finishNotification(job.id, lease);
  }
}

export function startTelegramWorker(store, { interval = 2000, onError = console.warn, ...telegram } = {}) {
  if (!telegram.token || !telegram.chatId) return { wake() {}, stop() {} };
  let running;
  let stopped = false;

  function wake() {
    if (stopped || running) return;
    running = deliverTelegram(store, { ...telegram, onError }, { isStopped: () => stopped }).catch(() => onError('The Telegram outbox is temporarily unavailable.')).finally(() => { running = null; });
  }

  const timer = setInterval(wake, interval);
  timer.unref();
  return {
    wake,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
