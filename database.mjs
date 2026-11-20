import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { branchNames } from './branches.mjs';
import { today, withBalance } from './public/sales.mjs';
import { managedBranch, notificationPayload, overviewReport, publicBranch, registerReport, sessionDetails } from './reports.mjs';
import { waitForSalesChange } from './sales-updates.mjs';

export function openStore(filename, { local, adminHash, initialPinHash, notifyOnSave = false }) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.function('entry_balance', { deterministic: true }, (kind, amounts) => withBalance(kind, JSON.parse(amounts)).balance);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pin_hash TEXT, pin_cipher TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('staff', 'admin')),
      branch_id INTEGER REFERENCES branches(id), expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_by_branch ON sessions(branch_id);
    CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS entries (
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      kind TEXT NOT NULL CHECK(kind IN ('slots', 'live')),
      day TEXT NOT NULL, amounts TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (branch_id, kind, day)
    );
    CREATE INDEX IF NOT EXISTS entries_by_day ON entries(day);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER
    );
  `);

  function transaction(operation, { write = true } = {}) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  transaction(() => {
    if (!db.prepare('PRAGMA table_info(branches)').all().some(column => column.name === 'pin_cipher')) {
      db.exec('ALTER TABLE branches ADD COLUMN pin_cipher TEXT');
    }
  });

  const getConfig = db.prepare('SELECT value FROM config WHERE key = ?');
  const salesChanges = new EventEmitter().setMaxListeners(0);
  const salesVersion = () => getConfig.get('sales_version')?.value ?? '0';
  const advanceSalesVersion = db.prepare(`INSERT INTO config (key, value) VALUES ('sales_version', '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
  const addConfig = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
  const setConfig = db.prepare('UPDATE config SET value = ? WHERE key = ?');
  const getBranch = db.prepare('SELECT id, name, pin_hash, pin_cipher FROM branches WHERE id = ?');
  const list = db.prepare('SELECT id, name, pin_hash IS NOT NULL AS pin_set FROM branches ORDER BY name');
  const addBranch = db.prepare('INSERT INTO branches (name, pin_hash, pin_cipher) VALUES (?, ?, ?)');
  const branchByName = db.prepare('SELECT id FROM branches WHERE name = ?');
  const updatePin = db.prepare('UPDATE branches SET pin_hash = ?, pin_cipher = ? WHERE id = ?');
  const unsealed = db.prepare('SELECT id, name FROM branches WHERE pin_cipher IS NULL ORDER BY id');
  const revokeBranch = db.prepare('DELETE FROM sessions WHERE branch_id = ?');
  const revokeAdmins = db.prepare("DELETE FROM sessions WHERE role = 'admin'");
  const addSession = db.prepare('INSERT INTO sessions (token_hash, role, branch_id, expires_at) VALUES (?, ?, ?, ?)');
  const revokeSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const getSession = db.prepare(`
    SELECT sessions.role, branches.id AS branch_id, branches.name AS branch_name
    FROM sessions LEFT JOIN branches ON sessions.branch_id = branches.id
    WHERE token_hash = ? AND expires_at > ?
  `);
  const branchEntries = db.prepare(`
    SELECT day, amounts, revision FROM entries
    WHERE branch_id = ? AND kind = ? AND day BETWEEN ? AND ? ORDER BY day
  `);
  const allEntries = db.prepare('SELECT branch_id, kind, amounts FROM entries WHERE day BETWEEN ? AND ?');
  const branchOpening = db.prepare(`
    SELECT COALESCE(SUM(entry_balance(kind, amounts)), 0) AS balance FROM entries
    WHERE branch_id = ? AND kind = ? AND day < ?
  `);
  const allOpenings = db.prepare(`
    SELECT branch_id, kind, SUM(entry_balance(kind, amounts)) AS balance FROM entries
    WHERE day < ? GROUP BY branch_id, kind
  `);
  const entryVersion = db.prepare('SELECT revision FROM entries WHERE branch_id = ? AND kind = ? AND day = ?');
  const writeEntry = db.prepare(`
    INSERT INTO entries (branch_id, kind, day, amounts, revision) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(branch_id, kind, day) DO UPDATE SET amounts = excluded.amounts, revision = excluded.revision
  `);
  const branchBalances = db.prepare(`
    SELECT kind, SUM(entry_balance(kind, amounts)) AS balance FROM entries
    WHERE branch_id = ? AND day <= ? GROUP BY kind
  `);
  const queueNotification = db.prepare('INSERT INTO notifications (payload, available_at) VALUES (?, ?)');
  const nextNotification = db.prepare(`
    SELECT id, payload, attempts FROM notifications
    WHERE available_at <= ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY id LIMIT 1
  `);
  const claimNotification = db.prepare('UPDATE notifications SET lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?');
  const retryNotification = db.prepare('UPDATE notifications SET available_at = ?, lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?');
  const completeNotification = db.prepare('DELETE FROM notifications WHERE id = ? AND lease_token = ?');

  const mode = local ? 'local' : 'production';
  transaction(() => {
    const existing = getConfig.get('mode');
    if (existing?.value === 'demo' && local) setConfig.run(mode, 'mode');
    else if (existing && existing.value !== mode) throw new Error('Use separate databases for local and production data.');
    if (!existing) {
      if (!adminHash) throw new Error('Set CAPITALBET_INITIAL_ADMIN_PASSWORD before first use of a local database.');
      addConfig.run('mode', mode);
      addConfig.run('admin_hash', adminHash);
      for (const name of branchNames) addBranch.run(name, initialPinHash, null);
    }
  });
  removeExpired.run(Date.now());

  const bounds = month => [`${month}-01`, `${month}-31`];

  return {
    get adminHash() { return getConfig.get('admin_hash').value; },
    initializeAdmin(hash) {
      transaction(() => {
        if (getConfig.get('managed_admin')) return;
        setConfig.run(hash, 'admin_hash');
        addConfig.run('managed_admin', '1');
        revokeAdmins.run();
      });
    },
    unsealedBranches: () => unsealed.all(),
    initializePins(protections) {
      transaction(() => {
        for (const { id, hash, cipher } of protections) {
          if (getBranch.get(id)?.pin_cipher) continue;
          updatePin.run(hash, cipher, id);
          revokeBranch.run(id);
        }
      });
    },
    branch: id => getBranch.get(id),
    branches: () => list.all().map(publicBranch),
    managedBranches: () => list.all().map(managedBranch),
    createBranch(name, pinHash, cipher = null) {
      return transaction(() => {
        if (branchByName.get(name)) return null;
        return { id: Number(addBranch.run(name, pinHash, cipher).lastInsertRowid), name, pinSet: true };
      });
    },
    changePin(id, pinHash, cipher = null) {
      return transaction(() => {
        if (!updatePin.run(pinHash, cipher, id).changes) return false;
        revokeBranch.run(id);
        return true;
      });
    },
    createSession(tokenHash, role, branch, expiresAt, expectedPinHash) {
      return transaction(() => {
        if (branch && getBranch.get(branch.id)?.pin_hash !== expectedPinHash) return false;
        removeExpired.run(Date.now());
        addSession.run(tokenHash, role, branch?.id ?? null, expiresAt);
        return true;
      });
    },
    deleteSession: tokenHash => revokeSession.run(tokenHash),
    revokeAdminSessions: () => revokeAdmins.run(),
    session: tokenHash => sessionDetails(getSession.get(tokenHash, Date.now())),
    watchSales: (since, signal) => waitForSalesChange(since, salesVersion, salesChanges, signal),
    register(id, kind, month, { includeSalesVersion = false } = {}) {
      return transaction(() => {
        const [firstDay, lastDay] = bounds(month);
        const opening = branchOpening.get(id, kind, firstDay).balance;
        const report = registerReport(kind, branchEntries.all(id, kind, firstDay, lastDay), opening);
        return includeSalesVersion ? { ...report, salesVersion: salesVersion() } : report;
      }, { write: false });
    },
    saveEntry(id, kind, day, revision, values, { sessionHash, role }) {
      const saved = transaction(() => {
        const session = sessionHash && getSession.get(sessionHash, Date.now());
        if (!session || session.role !== role || (role === 'staff' && session.branch_id !== id)) return false;
        const entry = entryVersion.get(id, kind, day);
        if (role === 'staff' && entry && day < today()) return 'locked';
        if (role === 'admin' && !entry) return 'missing';
        if ((entry?.revision ?? 0) !== revision) return null;
        writeEntry.run(id, kind, day, JSON.stringify(values), revision + 1);
        advanceSalesVersion.run();
        const result = withBalance(kind, values);
        if (notifyOnSave && role === 'staff') {
          const payload = notificationPayload(session.branch_name, day, kind, branchBalances.all(id, day), result.balance, Boolean(entry));
          queueNotification.run(JSON.stringify(payload), Date.now());
        }
        return { day, revision: revision + 1, values: result };
      });
      if (saved?.revision) salesChanges.emit('change');
      return saved;
    },
    overview(month) {
      return transaction(() => {
        const [firstDay, lastDay] = bounds(month);
        return { ...overviewReport(list.all(), allEntries.all(firstDay, lastDay), allOpenings.all(firstDay)), salesVersion: salesVersion() };
      }, { write: false });
    },
    claimNotification(lease, now, until) {
      return transaction(() => {
        const job = nextNotification.get(now, now);
        if (!job) return null;
        claimNotification.run(lease, until, job.id);
        return { ...job, payload: JSON.parse(job.payload) };
      });
    },
    finishNotification(id, lease, retryAt) {
      if (retryAt) retryNotification.run(retryAt, id, lease);
      else completeNotification.run(id, lease);
    },
    close: () => db.close(),
  };
}
