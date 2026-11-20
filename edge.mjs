import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError } from './api.mjs';
import { digest } from './credentials.mjs';

export function createEdgeHandler({ origin, getApi, cronSecret, sendNotifications }) {
  const cronHash = cronSecret && Buffer.from(digest(cronSecret));
  return async request => {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    const requester = request.headers.get('origin');
    if (requester && requester !== origin) return Response.json({ error: 'Open Capitalbet from its GitHub Pages address.' }, { status: 403, headers });
    if (requester) headers.set('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
      headers.set('Access-Control-Max-Age', '600');
      return new Response(null, { status: 204, headers });
    }

    try {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^(?:\/functions\/v1)?\/capitalbet(?=\/|$)/, '');
      if (url.pathname === '/cron/telegram' && request.method === 'POST') {
        const headerHash = digest(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
        if (!cronHash || !timingSafeEqual(Buffer.from(headerHash), cronHash)) throw new HttpError(403, 'Forbidden.');
        await sendNotifications();
        return new Response(null, { status: 204, headers });
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Page not found.');
      const edgeIp = request.headers.get('cf-connecting-ip') ?? '';
      const input = {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        async *[Symbol.asyncIterator]() { if (request.body) yield* request.body; },
      };
      const output = { statusCode: 200 };
      const api = await getApi();
      const data = await api(input, output, url, isIP(edgeIp) ? edgeIp : 'unknown', request.signal);
      return Response.json(data, { status: output.statusCode, headers });
    } catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers });
      console.error('Capitalbet API request failed.', error.code ?? error.name);
      return Response.json({ error: 'The Capitalbet service could not complete your request.' }, { status: 503, headers });
    }
  };
}
