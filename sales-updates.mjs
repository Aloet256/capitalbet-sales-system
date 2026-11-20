export async function waitForSalesChange(since, readVersion, changes, signal, timeout = 20_000) {
  const pending = Promise.withResolvers();
  const wake = pending.resolve;
  const timer = setTimeout(wake, timeout);
  changes.once('change', wake);
  signal?.addEventListener('abort', wake, { once: true });
  try {
    const version = await readVersion();
    if (version !== since || signal?.aborted) return version;
    await pending.promise;
    return await readVersion();
  } finally {
    clearTimeout(timer);
    changes.off('change', wake);
    signal?.removeEventListener('abort', wake);
  }
}
