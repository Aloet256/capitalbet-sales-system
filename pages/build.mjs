import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const configured = process.env.CAPITALBET_SUPABASE_URL?.trim();
if (!configured) throw new Error('Set the public CAPITALBET_SUPABASE_URL repository variable before publishing.');
const project = new URL(configured);
if (project.protocol !== 'https:' || !/^[a-z]{20}\.supabase\.co$/.test(project.hostname) || project.port
  || project.username || project.password || project.pathname !== '/' || project.search || project.hash) {
  throw new Error('CAPITALBET_SUPABASE_URL must be the hosted Supabase project HTTPS origin.');
}

const api = `${project.origin}/functions/v1/capitalbet/api`;
const csp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${project.origin}; base-uri 'none'; form-action 'self'`;
const assets = new URL('../public/', import.meta.url);
const index = (await readFile(new URL('index.html', assets), 'utf8'))
  .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <meta name="capitalbet-api" content="${api}">`)
  .replaceAll('href="/', 'href="./')
  .replaceAll('src="/', 'src="./');

const output = new URL('../dist/pages/', import.meta.url);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(new URL('index.html', output), index),
  ...['app.mjs', 'sales.mjs', 'ui.mjs', 'styles.css', 'capitalbet-logo.png']
    .map(name => copyFile(new URL(name, assets), new URL(name, output))),
]);
