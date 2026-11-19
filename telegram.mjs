import { randomUUID } from 'node:crypto';
import { dateName, money } from './public/ui.mjs';

export function salesMessage({ branch, day, kind, balances }) {
  const register = kind === 'slots' ? 'Slots' : 'Live-in-Play';
  return [
    `${branch} filled in ${register} figures.`,
    `Date: ${dateName(day)}`,
    `Slots balance: ${money(balances.slots ?? 0)}`,
    `Live-in-Play balance: ${money(balances.live ?? 0)}`,
  ].join('\n');
}

export function startTelegramWorker(store, { token, chatId, fetcher = fetch, interval = 2000, onError = console.warn } = {}) {
  if (!token || !chatId) return { wake() {}, stop() {} };
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  let running;
  let stopped = false;

  async function deliver() {
    while (!stopped) {
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

  function wake() {
    if (stopped || running) return;
    running = deliver().catch(() => onError('The Telegram outbox is temporarily unavailable.')).finally(() => { running = null; });
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
