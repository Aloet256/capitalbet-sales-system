import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

export const configFile = () => process.env.CAPITALBET_CONFIG ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.config'), 'Capitalbet', 'config.env');

export function loadConfig() {
  const path = configFile();
  if (existsSync(path)) loadEnvFile(path);
  return process.env;
}

export function postgresOptions(env) {
  if (!env.DATABASE_URL) throw new Error('Set DATABASE_URL in the private Capitalbet configuration.');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL is not a valid PostgreSQL connection string.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(option);
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(env.SUPABASE_DB_CA_PATH ? { ca: readFileSync(env.SUPABASE_DB_CA_PATH) } : {}) },
    connectionTimeoutMillis: 8000,
    max: 4,
  };
}
