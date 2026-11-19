import { emptyTotals, sumTotals, withBalance } from './public/sales.mjs';

export const publicBranch = ({ id, name }) => ({ id, name });
export const managedBranch = row => ({ ...publicBranch(row), pinSet: Boolean(row.pin_set) });
export const sessionDetails = row => row ? {
  role: row.role,
  branch: row.branch_id == null ? null : { id: row.branch_id, name: row.branch_name },
} : null;

function closeMonth(totals, openingBalance = 0) {
  return { ...totals, openingBalance, monthlyMovement: totals.balance, balance: openingBalance + totals.balance };
}

const amounts = raw => typeof raw === 'string' ? JSON.parse(raw) : raw;

export function registerReport(kind, rows, opening) {
  const totals = emptyTotals(kind);
  const records = rows.map(row => {
    const values = withBalance(kind, amounts(row.amounts));
    sumTotals(totals, values);
    return { day: row.day, revision: row.revision, values };
  });
  return { records, totals: closeMonth(totals, opening) };
}

export function overviewReport(branchRows, entryRows, openingRows) {
  const totals = { slots: emptyTotals('slots'), live: emptyTotals('live') };
  const branches = branchRows.map(row => ({
    ...publicBranch(row), slots: emptyTotals('slots'), live: emptyTotals('live'), entries: 0,
    entriesByRegister: { slots: 0, live: 0 },
  }));
  const byId = new Map(branches.map(branch => [branch.id, branch]));
  for (const row of entryRows) {
    const values = withBalance(row.kind, amounts(row.amounts));
    const branch = byId.get(row.branch_id);
    sumTotals(branch[row.kind], values);
    sumTotals(totals[row.kind], values);
    branch.entries++;
    branch.entriesByRegister[row.kind]++;
  }
  const openings = { slots: 0, live: 0 };
  for (const row of openingRows) {
    const balance = Number(row.balance);
    byId.get(row.branch_id)[row.kind].openingBalance = balance;
    openings[row.kind] += balance;
  }
  for (const kind of ['slots', 'live']) {
    totals[kind] = closeMonth(totals[kind], openings[kind]);
    for (const branch of branches) branch[kind] = closeMonth(branch[kind], branch[kind].openingBalance);
  }
  return { totals, branches };
}

export function notificationPayload(branch, day, kind, balances) {
  return { branch, day, kind, balances: Object.fromEntries(balances.map(row => [row.kind, Number(row.balance)])) };
}
