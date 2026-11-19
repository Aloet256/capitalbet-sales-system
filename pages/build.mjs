import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';

function onlineAccess(address) {
  let url;
  try { url = new URL(address); } catch { throw new Error('CAPITALBET_APP_URL must be the HTTPS origin of the deployed app.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || url.hostname.endsWith('.localhost')
    || url.hostname === 'github.io' || url.hostname.endsWith('.github.io')) {
    throw new Error('CAPITALBET_APP_URL must be a separate public HTTPS hostname with no path or credentials.');
  }
  return `<h2 id="access-heading">Sign in to Capitalbet</h2>
        <p>Choose the branch staff or administrator sign-in.</p>
        <div class="stack-form entry-actions">
          <a class="btn primary" href="${url.origin}/">Branch staff sign-in</a>
          <a class="btn secondary" href="${url.origin}/admin/login">Administrator sign-in</a>
        </div>`;
}

const localAccess = `<h2 id="access-heading">Capitalbet access</h2>
        <p>Online sign-in is pending. If Capitalbet is running on this computer, you can open the local system.</p>
        <div class="stack-form entry-actions">
          <a class="btn primary" href="http://127.0.0.1:3000/">Open local staff sign-in</a>
          <a class="btn secondary" href="http://127.0.0.1:3000/admin/login">Open local administrator sign-in</a>
        </div>`;

const address = process.env.CAPITALBET_APP_URL?.trim();
const access = address ? onlineAccess(address) : localAccess;
const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const output = new URL('../dist/pages/', import.meta.url);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(new URL('index.html', output), template.replace('<!-- APPLICATION ACCESS -->', access)),
  copyFile(new URL('../public/styles.css', import.meta.url), new URL('styles.css', output)),
  copyFile(new URL('../public/capitalbet-logo.png', import.meta.url), new URL('capitalbet-logo.png', output)),
]);
