import pg from 'pg';
import { withBalance } from './public/sales.mjs';
import { managedBranch, notificationPayload, overviewReport, publicBranch, registerReport, sessionDetails } from './reports.mjs';

export function makePool(options) {
  const pool = new pg.Pool(options);
  pool.on('error', () => console.error('The Supabase database connection was interrupted.'));
  return pool;
}

export async function postgresTransaction(pool, operation, readOnly = false) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function openPostgresStore(pool, { notifyOnSave = false } = {}) {
  const first = async (queryable, sql, args = []) => (await queryable.query(sql, args)).rows[0];
  const rows = async (queryable, sql, args = []) => (await queryable.query(sql, args)).rows;
  const list = 'SELECT id, name, true AS pin_set FROM capitalbet.branches ORDER BY name';
  const branchSql = 'SELECT id, name, pin_hash, pin_cipher FROM capitalbet.branches WHERE id = $1';
  const sessionSql = `SELECT s.role, s.branch_id, b.name AS branch_name FROM capitalbet.sessions s
    LEFT JOIN capitalbet.branches b ON b.id = s.branch_id WHERE s.token_hash = $1 AND s.expires_at > $2`;
  const lookupSession = (client, token) => first(client, sessionSql, [token, Date.now()]);
  const setting = await first(pool, "SELECT value FROM capitalbet.config WHERE key = 'admin_user_id'");
  if (!setting) throw new Error('Run the Supabase setup script before starting the app.');

  return {
    adminUserId: setting.value,
    branch: id => first(pool, branchSql, [id]),
    branches: async () => (await rows(pool, list)).map(publicBranch),
    managedBranches: async () => (await rows(pool, list)).map(managedBranch),
    async createBranch(name, hash, cipher) {
      const branch = await first(pool, `INSERT INTO capitalbet.branches (name, pin_hash, pin_cipher)
        VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING RETURNING id, name, true AS pin_set`, [name, hash, cipher]);
      return branch ? managedBranch(branch) : null;
    },
    changePin(id, hash, cipher) {
      return postgresTransaction(pool, async client => {
        const changed = await client.query('UPDATE capitalbet.branches SET pin_hash = $1, pin_cipher = $2 WHERE id = $3', [hash, cipher, id]);
        if (!changed.rowCount) return false;
        await client.query('DELETE FROM capitalbet.sessions WHERE branch_id = $1', [id]);
        return true;
      });
    },
    createSession(hash, role, branch, expiry, expectedPinHash) {
      return postgresTransaction(pool, async client => {
        const current = branch && await first(client, `${branchSql} FOR UPDATE`, [branch.id]);
        if (branch && current?.pin_hash !== expectedPinHash) return false;
        await client.query('DELETE FROM capitalbet.sessions WHERE expires_at <= $1', [Date.now()]);
        await client.query('INSERT INTO capitalbet.sessions (token_hash, role, branch_id, expires_at) VALUES ($1,$2,$3,$4)',
          [hash, role, branch?.id ?? null, expiry]);
        return true;
      });
    },
    deleteSession: hash => pool.query('DELETE FROM capitalbet.sessions WHERE token_hash = $1', [hash]),
    revokeAdminSessions: () => pool.query("DELETE FROM capitalbet.sessions WHERE role = 'admin'"),
    session: async hash => sessionDetails(await lookupSession(pool, hash)),
    register(id, kind, month) {
      return postgresTransaction(pool, async client => {
        const params = [id, kind, `${month}-01`];
        const opening = await first(client, `SELECT COALESCE(SUM(net_balance),0) AS balance FROM capitalbet.entries
          WHERE branch_id = $1 AND kind = $2 AND day < $3::date`, params);
        const entries = await rows(client, `SELECT to_char(day, 'YYYY-MM-DD') AS day, amounts, revision FROM capitalbet.entries
          WHERE branch_id = $1 AND kind = $2 AND day >= $3::date AND day < $3::date + INTERVAL '1 month' ORDER BY day`, params);
        return registerReport(kind, entries, Number(opening.balance));
      }, true);
    },
    saveEntry(id, kind, day, revision, values, sessionHash) {
      return postgresTransaction(pool, async client => {
        const branch = await first(client, `${branchSql} FOR UPDATE`, [id]);
        const session = branch && await lookupSession(client, sessionHash);
        if (!session || session.role !== 'staff' || session.branch_id !== id) return false;
        const current = await first(client, 'SELECT revision FROM capitalbet.entries WHERE branch_id = $1 AND kind = $2 AND day = $3', [id, kind, day]);
        if ((current?.revision ?? 0) !== revision) return null;
        const result = withBalance(kind, values);
        await client.query(`INSERT INTO capitalbet.entries (branch_id, kind, day, amounts, net_balance, revision)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (branch_id, kind, day) DO UPDATE
          SET amounts = excluded.amounts, net_balance = excluded.net_balance, revision = excluded.revision`,
          [id, kind, day, JSON.stringify(values), result.balance, revision + 1]);
        if (notifyOnSave) {
          const balances = await rows(client, `SELECT kind, SUM(net_balance) AS balance FROM capitalbet.entries
            WHERE branch_id = $1 AND day <= $2 GROUP BY kind`, [id, day]);
          const payload = notificationPayload(branch.name, day, kind, balances);
          await client.query('INSERT INTO capitalbet.notifications (payload, available_at) VALUES ($1,$2)', [JSON.stringify(payload), Date.now()]);
        }
        return { day, revision: revision + 1, values: result };
      });
    },
    overview(month) {
      return postgresTransaction(pool, async client => {
        const firstDay = [`${month}-01`];
        const branches = await rows(client, list);
        const entries = await rows(client, `SELECT branch_id, kind, amounts FROM capitalbet.entries
          WHERE day >= $1::date AND day < $1::date + INTERVAL '1 month'`, firstDay);
        const openings = await rows(client, `SELECT branch_id, kind, SUM(net_balance) AS balance FROM capitalbet.entries
          WHERE day < $1::date GROUP BY branch_id, kind`, firstDay);
        return overviewReport(branches, entries, openings);
      }, true);
    },
    claimNotification(lease, now, until) {
      return first(pool, `WITH job AS (
        SELECT id FROM capitalbet.notifications WHERE available_at <= $1 AND (lease_until IS NULL OR lease_until <= $1)
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE capitalbet.notifications n SET lease_token = $2, lease_until = $3, attempts = n.attempts + 1
      FROM job WHERE n.id = job.id RETURNING n.id, n.payload, n.attempts - 1 AS attempts`, [now, lease, until]);
    },
    finishNotification(id, lease, retryAt) {
      if (retryAt) return pool.query('UPDATE capitalbet.notifications SET available_at = $3, lease_until = NULL, lease_token = NULL WHERE id = $1 AND lease_token = $2', [id, lease, retryAt]);
      return pool.query('DELETE FROM capitalbet.notifications WHERE id = $1 AND lease_token = $2', [id, lease]);
    },
    close: () => pool.end(),
  };
}
