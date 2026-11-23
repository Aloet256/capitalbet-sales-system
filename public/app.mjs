import { daysInMonth, registers, today, validMonth, withBalance } from './sales.mjs';
import {
  branchName, dateName, errorBox, escapeHtml, fieldList, groupMoneyInput, icon, loader, logo, money,
  monthName, monthPicker, notice, number, pageHeading, parseMoneyInput, salesFigure, searchInput, weekday,
} from './ui.mjs';

const root = document.querySelector('#app');
const editor = document.querySelector('#editor');
const toast = document.querySelector('#toast');
const supabaseApi = document.querySelector('meta[name="capitalbet-api"]')?.content;
const sessionKey = 'capitalbet-sales-session';
const routeHref = path => supabaseApi ? `#${path}` : path;
let current;
let version = 0;
let toastTimeout;
let status;
let sessionToken;
let salesWatch;
if (supabaseApi) {
  try { sessionToken = sessionStorage.getItem(sessionKey); } catch { /* Storage may be unavailable. */ }
}

function rememberSession(token) {
  sessionToken = token;
  try {
    if (token) sessionStorage.setItem(sessionKey, token);
    else sessionStorage.removeItem(sessionKey);
  } catch { /* This page can still keep the session in memory. */ }
}

async function api(path, { method = 'GET', body, ...options } = {}) {
  const init = { method, ...options, headers: new Headers(options.headers) };
  const previousToken = sessionToken;
  if (supabaseApi && previousToken) init.headers.set('Authorization', `Bearer ${previousToken}`);
  if (body !== undefined) {
    init.headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${supabaseApi ?? '/api'}/${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 404 && path === 'status' ? 'Capitalbet is waiting for its Supabase service.' : data.error ?? 'The request could not be completed.';
    throw Object.assign(new Error(message), { status: response.status });
  }
  if (supabaseApi && /^login\/(staff|admin)$/.test(path)) {
    if (!/^[\da-f]{64}$/.test(data.token ?? '')) throw new Error('Capitalbet could not start a session.');
    rememberSession(data.token);
  }
  if (supabaseApi && previousToken === sessionToken && (path === 'logout' || (path === 'session' && !data.session))) rememberSession(null);
  return data;
}

function currentAddress() {
  return supabaseApi ? new URL(location.hash.startsWith('#/') ? location.hash.slice(1) : '/', location.origin) : new URL(location.href);
}

function route() {
  const address = currentAddress();
  const path = address.pathname.replace(/\/$/, '') || '/';
  const query = address.searchParams;
  const month = validMonth(query.get('month')) ? query.get('month') : today().slice(0, 7);
  const overviewKind = query.get('register') === 'live' ? 'live' : 'slots';
  const branch = path.match(/^\/admin\/branches\/(\d+)(?:\/(slots|live))?$/);
  if (branch) return { type: 'detail', role: 'admin', month, id: Number(branch[1]), kind: branch[2] ?? 'slots' };
  const pages = {
    '/': { type: 'login', role: 'staff' }, '/dashboard': { type: 'dashboard', role: 'staff' },
    '/slots': { type: 'register', role: 'staff', kind: 'slots' }, '/live': { type: 'register', role: 'staff', kind: 'live' },
    '/admin/login': { type: 'login', role: 'admin' }, '/admin': { type: 'overview', role: 'admin', kind: overviewKind },
    '/admin/forgot-password': { type: 'recovery', role: 'admin' },
    '/admin/branches': { type: 'branches', role: 'admin' },
  };
  return { ...(pages[path] ?? { type: 'missing' }), month };
}

const periodUrl = (path, month) => `${path}?month=${encodeURIComponent(month)}`;
const overviewUrl = (month, kind = 'slots') => `${periodUrl('/admin', month)}&register=${kind}`;
const loginUrl = role => role === 'admin' ? '/admin/login' : '/';
const landingUrl = role => role === 'admin' ? '/admin' : '/dashboard';

function navigate(url, { replace = false, focus = true, keepScroll = false } = {}) {
  if (editor.open) editor.close();
  history[replace ? 'replaceState' : 'pushState'](null, '', routeHref(url));
  if (!keepScroll) window.scrollTo(0, 0);
  return loadPage(focus);
}

function activeLink(href, name, glyph, active) {
  return `<a href="${routeHref(href)}" ${active ? 'class="active" aria-current="page"' : ''}>${icon(glyph)}<span>${name}</span></a>`;
}

function shell(state, contents) {
  const admin = state.role === 'admin';
  const context = admin ? 'Administrator' : branchName(state.session.branch.name);
  const overview = overviewUrl(state.month, state.kind);
  const links = admin
    ? `${activeLink(overview, 'Sales Overview', 'chart', ['overview', 'detail'].includes(state.type))}${activeLink('/admin/branches', 'Branch Management', 'branch', state.type === 'branches')}`
    : `${activeLink('/dashboard', 'Dashboard', 'home', state.type === 'dashboard')}
       ${activeLink(periodUrl('/slots', state.month), 'Slots Register', 'slots', state.kind === 'slots')}
       ${state.kind === 'slots' ? '' : activeLink(periodUrl('/live', state.month), 'Live-in-Play Register', 'live', state.kind === 'live')}`;
  const currentTitle = { overview: 'Sales Overview', detail: 'Branch Sales', branches: 'Branch Management', dashboard: 'Dashboard', register: `${state.kind ? registers[state.kind].title : ''} Register` }[state.type];
  return `<div class="shell">
    <a href="#main" class="skip-link">Skip to content</a>
    <aside class="sidebar" id="sidebar">
      <a class="sidebar-brand" href="${routeHref(admin ? overview : landingUrl(state.role))}">${logo}<span>Sales System</span></a>
      <div class="sidebar-nav"><p>${admin ? 'ADMIN WORKSPACE' : 'STAFF WORKSPACE'}</p><nav aria-label="Main navigation">${links}</nav></div>
      <div class="sidebar-bottom"><div class="identity"><span class="identity-icon">${icon(admin ? 'shield' : 'branch', 18)}</span><div><strong>${context}</strong><span>${admin ? 'Admin access' : 'Branch staff'}</span></div></div>
      <button type="button" class="signout" data-action="logout">${icon('exit', 19)} Sign out</button></div>
    </aside>
    <div class="workspace${state.type === 'overview' ? ' overview-workspace' : ''}"><header class="topbar"><div class="toppath">
      <button class="icon-btn menu-toggle" data-action="menu" aria-label="Toggle navigation" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
      <span>${admin ? 'Admin' : 'Staff'}</span><span class="path-divider">/</span><strong>${currentTitle}</strong>
      </div><div class="top-context"><span class="context-name">${icon(admin ? 'shield' : 'branch', 17)} ${context}</span></div></header>
      <main id="main" class="workspace-content">${contents}</main>
    </div>
  </div>`;
}

function recoveryFields(step = 'request') {
  const heading = '<h2 id="sign-in-title" tabindex="-1">Reset administrator password</h2>';
  const back = `<div class="login-switch"><a href="${routeHref('/admin/login')}">Administrator sign-in</a></div>`;
  if (!status.passwordRecovery) return `${heading}<p>Email recovery will be available when Supabase email delivery is configured.</p>${back}`;
  const details = {
    request: ['Send a one-time code to the administrator email address.', '', 'Send reset code'],
    verify: ['Enter the reset code from your email.', '<label for="reset-code">Reset code</label><input id="reset-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required>', 'Verify code'],
    reset: ['Choose a new password with at least eight characters.', '<label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required><label for="confirm-password">Confirm password</label><input id="confirm-password" name="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="256" required>', 'Save password'],
  };
  const [copy, fields, label] = step === 'reset' && supabaseApi
    ? ['Enter the code from your email and choose a new password.', `${details.verify[1]}${details.reset[1]}`, 'Save password']
    : details[step];
  return `${heading}<p>${copy}</p><form class="stack-form" data-form="recovery-${step}">${fields}${errorBox}
    <button class="btn primary login-submit" type="submit">${label}</button></form>
    ${step !== 'request' ? `<div class="forgot-link"><a href="${routeHref('/admin/forgot-password')}">Start over</a></div>` : ''}${back}`;
}

function loginPage(state) {
  const admin = state.role === 'admin';
  let savedBranch = '';
  try { savedBranch = localStorage.getItem('capitalbet-branch') ?? ''; } catch { /* Storage may be unavailable. */ }
  const options = state.branches?.map(({ id, name }) => `<option value="${id}" ${String(id) === savedBranch ? 'selected' : ''}>${branchName(name)}</option>`).join('') ?? '';
  return `<main class="login-layout">
    <section class="login-brand">
      <div class="login-brand-inner">${logo}<div class="brand-rule"></div>
        <p class="eyebrow">CAPITALBET OPERATIONS</p><h1>Slots and<br> Live-in-Play<br> <span>Sales System</span></h1>
        <p class="login-lede">Daily sales registers and monthly reporting for Capitalbet branches.</p>
        <div class="brand-features"><span>${icon('slots')} Slots</span><span>${icon('live')} Live-in-Play</span></div>
      </div>
    </section>
    <section class="login-workspace" aria-labelledby="sign-in-title">
      <div class="login-card"><div class="login-icon">${icon(admin ? 'shield' : 'lock', 24)}</div>
        ${state.offline ? `<h2 id="sign-in-title" tabindex="-1">${admin ? 'Administrator sign-in' : 'Branch sign-in'}</h2>
          <p>${escapeHtml(state.offline)}</p><button class="btn primary" data-action="retry">Try again</button>
          <div class="login-switch"><a href="${routeHref(admin ? '/' : '/admin/login')}">${admin ? 'Branch staff sign-in' : 'Administrator sign-in'}</a></div>`
        : state.type === 'recovery' ? recoveryFields(state.recoveryStep) : `<h2 id="sign-in-title" tabindex="-1">${admin ? 'Administrator sign-in' : 'Branch sign-in'}</h2>
        <p>${admin ? 'Enter your password to access sales reports and manage branches.' : 'Select your branch and enter its PIN to access the sales registers.'}</p>
        <form data-form="${admin ? 'admin-login' : 'staff-login'}" class="stack-form">
          ${admin ? `<label for="password">Administrator password</label><div class="secret-field"><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required maxlength="256"><button type="button" class="icon-btn" data-action="reveal" aria-label="Show password" aria-pressed="false">${icon('eye', 19)}</button></div>`
            : `<label for="branch-select">Branch</label><select id="branch-select" name="branchId" required><option value="">Select your branch</option>${options}</select><label for="staff-pin">Branch PIN</label><div class="secret-field"><input id="staff-pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" minlength="${status.pinLength}" maxlength="12" pattern="[0-9]{${status.pinLength},12}" placeholder="Enter branch PIN" required><button type="button" class="icon-btn" data-action="reveal" aria-label="Show PIN" aria-pressed="false">${icon('eye', 19)}</button></div>`}
          ${errorBox}<button class="btn primary login-submit" type="submit">Sign in</button>
        </form>
        ${admin ? `<div class="forgot-link"><a href="${routeHref('/admin/forgot-password')}">Forgot password?</a></div>` : ''}
        <div class="login-switch"><a href="${routeHref(admin ? '/' : '/admin/login')}">${admin ? 'Branch staff sign-in' : 'Administrator sign-in'}</a></div>`}
      </div>
      <footer>Capitalbet <span>·</span> Sales System</footer>
    </section>
  </main>`;
}

function dashboard(state) {
  const options = Object.entries(registers).map(([kind, register]) => `<article class="panel register-card ${kind}">
    <div class="module-icon">${icon(register.icon, 28)}</div><h2>${register.title}</h2><p>${register.description}</p>
    <a class="btn ${kind === 'slots' ? 'primary' : 'secondary'}" href="${routeHref(periodUrl(`/${kind}`, state.month))}">Open ${register.title} Register</a>
  </article>`).join('');
  return `${pageHeading('Sales Dashboard', 'Choose a register to record or review your branch sales.')}
    <section class="branch-banner"><div class="banner-content"><div class="banner-label">${icon('branch', 18)} YOUR BRANCH</div><h2>${branchName(state.session.branch.name)}</h2>
    <div class="banner-date">${icon('calendar', 17)} ${dateName(today())}</div></div><div class="banner-art" aria-hidden="true"></div></section>
    <div class="section-heading"><h2>Sales registers</h2><span>${monthName(state.month)}</span></div><div class="register-card-grid">${options}</div>`;
}

const totalCashAtHandLabel = 'TOTAL CASH AT HAND';
const todaysCashAtHandLabel = 'TODAYS CASH AT HAND';

function totalCards(kind, totals) {
  const balances = [['balance', totalCashAtHandLabel], ['openingBalance', 'Opening balance'], ['monthlyMovement', 'This month’s movement']];
  const cards = fields => fields.map(([key, label]) => `<div class="total-card ${key === 'balance' ? 'balance-card' : ''}">
    <div class="total-label">${label}</div><div class="total-number ${totals[key] < 0 ? 'negative' : ''}">${salesFigure(totals[key], key)}</div>
  </div>`).join('');
  return `<div class="balance-summary">${cards(balances)}</div><div class="totals-grid">${cards(registers[kind].fields)}</div>`;
}

function salesCell(key, value) {
  const formatted = value === undefined ? '<span class="empty-value">—</span>' : salesFigure(value, key);
  return `<td class="${key === 'balance' ? 'balance-cell' : ''} ${value < 0 ? 'negative' : ''}">${formatted}</td>`;
}

function entryAction(day, record, staff, currentDay) {
  if (!staff && !record) return '';
  if (staff && record && day < currentDay) return '<span class="entry-locked">Locked</span>';
  const label = record ? 'Edit' : 'Add';
  return `<button type="button" class="row-btn" data-action="edit-entry" data-day="${day}" aria-label="${label} entry for ${dateName(day)}">${icon(record ? 'edit' : 'plus', 16)}<span>${label}</span></button>`;
}

function registerView(state) {
  const { kind, month, data } = state;
  const staff = state.type === 'register';
  const fields = [['balance', 'Running Balance'], ['monthlyMovement', todaysCashAtHandLabel], ...registers[kind].fields];
  const days = daysInMonth(month);
  const currentDay = today();
  const rows = new Map(data.records.map(record => [record.day, record]));
  const balanceFormula = kind === 'slots' ? 'Total In + Cash In − Total Out − Expenses − Cash Out − Free Coupons' : 'Total In − Total Out';
  const actions = staff ? `<button class="btn primary" data-action="pick-entry">${icon('plus', 18)} Add entry</button>` : '';
  let runningBalance = data.totals.openingBalance;
  const body = days.map(day => {
    const record = rows.get(day);
    let values;
    if (record) {
      runningBalance += record.values.balance;
      values = { ...record.values, balance: runningBalance, monthlyMovement: record.values.balance };
    }
    return `<tr class="${day === currentDay ? 'current-day' : ''}">
      <th scope="row"><span class="date-day">${day.slice(-2)}</span><span class="date-weekday">${weekday(day)}</span></th>
      ${fields.map(([key]) => salesCell(key, values?.[key])).join('')}
      <td class="day-action">${entryAction(day, record, staff, currentDay)}</td>
    </tr>`;
  }).join('');
  const back = staff ? '' : `<a class="back-link" href="${routeHref(overviewUrl(month, kind))}">Sales overview</a>`;
  const tabs = staff ? '' : registerTabs(kind, month, `/admin/branches/${state.id}`);
  const description = staff ? registers[kind].description : branchName(data.branch.name);
  return `${back}${pageHeading(`${registers[kind].title} Monthly Sales Register`, description, monthPicker(month))}${tabs}
    <section class="monthly-totals" data-sales-part="totals"><div class="section-heading"><h2>Monthly totals</h2><span>${monthName(month)}</span></div>${totalCards(kind, data.totals)}</section>
    <section class="panel table-panel"><div class="table-title"><div><h2>Daily entries</h2><p data-sales-part="count">${data.records.length} of ${days.length} days recorded${staff ? ' · Only an administrator can edit locked entries.' : ''}</p></div>${actions}</div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Daily ${registers[kind].title} entries"><table class="register-table ${kind}"><thead><tr><th scope="col">Date</th>${fields.map(([, label]) => `<th scope="col">${label}</th>`).join('')}<th scope="col" class="day-action">Action</th></tr></thead><tbody data-sales-part="rows">${body}</tbody>
      <tfoot data-sales-part="closing"><tr class="opening-total"><th scope="row">Opening balance</th>${salesCell('balance', data.totals.openingBalance)}<td colspan="${fields.length}"></td></tr>
      <tr><th scope="row">Monthly total</th>${fields.map(([key]) => salesCell(key, data.totals[key])).join('')}<td></td></tr></tfoot></table></div>
      <p class="table-note">${todaysCashAtHandLabel} = ${balanceFormula}. Running balance adds each day’s cash at hand to the opening balance.</p>
    </section>`;
}

function registerTabs(kind, month, path) {
  const href = type => path === '/admin' ? overviewUrl(month, type) : periodUrl(`${path}/${type}`, month);
  return `<nav class="tabs" aria-label="Sales register">${Object.entries(registers).map(([key, register]) => `<a href="${routeHref(href(key))}" ${key === kind ? 'aria-current="page"' : ''}>${icon(register.icon, 18)}${register.title}</a>`).join('')}</nav>`;
}

function salesRows(state, term = '') {
  const { branches } = state.data;
  const fields = fieldList(state.kind);
  const filtered = branches.filter(branch => branch.name.toLowerCase().includes(term.toLowerCase().trim()));
  return filtered.length ? filtered.map(branch => `<tr><th scope="row"><a class="table-link" href="${routeHref(periodUrl(`/admin/branches/${branch.id}/${state.kind}`, state.month))}">${branchName(branch.name)}</a></th>
    ${fields.map(([key]) => salesCell(key, branch[state.kind][key])).join('')}
    <td class="row-actions"><a class="row-btn" href="${routeHref(periodUrl(`/admin/branches/${branch.id}/${state.kind}`, state.month))}" aria-label="View ${branchName(branch.name)}">View</a></td></tr>`).join('')
    : `<tr><td class="no-results" colspan="${fields.length + 2}">No branches match your search.</td></tr>`;
}

function overview(state) {
  const { month, data, kind } = state;
  const register = registers[kind];
  const totals = data.totals[kind];
  const reporting = data.branches.filter(branch => branch.entriesByRegister[kind] > 0).length;
  const meta = [
    ['ALL BRANCH COLLECTIONS', money(totals.balance), register.icon, kind === 'live' ? 'gold' : 'red'],
    ['PREVIOUS MONTH TOTAL BALANCE TRANSFERED', money(totals.openingBalance), 'coins', 'dark'],
    ['This Month Acumulation', money(totals.monthlyMovement), 'chart', 'plain'],
    ['Branches with entries', `${reporting} / ${data.branches.length}`, 'branch', 'plain'],
  ];
  const fields = fieldList(kind);
  return `${pageHeading(`${register.title} Sales Overview`, 'Review monthly sales figures across all Capitalbet branches.', monthPicker(month))}
    ${registerTabs(kind, month, '/admin')}
    <div class="overview-cards" data-sales-part="totals">${meta.map(([label, value, glyph, theme]) => `<article class="panel overview-card"><span class="metric-icon ${theme}">${icon(glyph, 21)}</span><p>${label}</p><strong>${value}</strong></article>`).join('')}</div>
    <section class="panel table-panel overview-branches"><div class="table-title"><div><h2>Branch sales</h2><p>${monthName(month)}</p></div>${searchInput('Search branches')}</div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="${register.title} branch sales"><table class="overview-table ${kind}"><thead><tr><th scope="col">Branch</th>${fields.map(([key, label]) => `<th scope="col">${key === 'balance' ? totalCashAtHandLabel : label}</th>`).join('')}<th scope="col">Details</th></tr></thead>
      <tbody id="branch-rows" data-sales-part="rows">${salesRows(state, state.search)}</tbody><tfoot data-sales-part="closing"><tr><th scope="row">All branches total</th>${fields.map(([key]) => salesCell(key, totals[key])).join('')}<td></td></tr></tfoot></table></div>
    </section>`;
}

function managedRows(state, term = '') {
  const filtered = state.data.branches.filter(branch => branch.name.toLowerCase().includes(term.toLowerCase().trim()));
  return filtered.length ? filtered.map(branch => `<tr><th scope="row"><span class="branch-row-icon">${icon('branch', 16)}</span>${branchName(branch.name)}</th>
    <td><span class="pin-status ${branch.pinSet ? 'set' : ''}">${icon(branch.pinSet ? 'check' : 'lock', 15)} ${branch.pinSet ? 'PIN set' : 'PIN required'}</span></td>
    <td class="row-actions">${status.managedPins && branch.pinSet ? `<button class="row-btn" data-action="view-pin" data-id="${branch.id}">${icon('eye', 16)} View PIN</button>` : ''}<button class="row-btn" data-action="change-pin" data-id="${branch.id}">${icon('lock', 16)} ${status.managedPins ? 'Reset PIN' : branch.pinSet ? 'Change PIN' : 'Set PIN'}</button></td></tr>`).join('')
    : '<tr><td class="no-results" colspan="3">No branches match your search.</td></tr>';
}

function manageBranches(state) {
  return `${pageHeading('Branch Management', 'Add branches and manage staff sign-in PINs.', `<button class="btn primary" data-action="new-branch">${icon('plus', 19)} Add branch</button>`)}
    <section class="panel table-panel"><div class="table-title"><div><h2>Branches</h2><p>${state.data.branches.length} Capitalbet branches</p></div>${searchInput('Search branches', state.search)}</div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Branch PIN management"><table class="manage-table"><thead><tr><th scope="col">Branch</th><th scope="col">Staff access</th><th scope="col">Action</th></tr></thead><tbody id="branch-rows">${managedRows(state, state.search)}</tbody></table></div>
    </section>`;
}

function adminSalesPath(state) {
  const path = state.type === 'overview' ? 'admin/overview' : `admin/branches/${state.id}/${state.kind}`;
  return `${path}?month=${state.month}`;
}

function renderSalesUpdate(state) {
  const draft = document.createElement('template');
  draft.innerHTML = state.type === 'overview' ? overview(state) : registerView(state);
  for (const part of draft.content.querySelectorAll('[data-sales-part]')) {
    const target = root.querySelector(`[data-sales-part="${part.dataset.salesPart}"]`);
    if (target.innerHTML === part.innerHTML) continue;
    const focused = target.contains(document.activeElement) ? document.activeElement : null;
    target.replaceChildren(...part.childNodes);
    if (focused) {
      const key = focused.dataset.day ?? focused.getAttribute('aria-label') ?? focused.getAttribute('href');
      [...target.querySelectorAll('a,button')].find(control => (control.dataset.day ?? control.getAttribute('aria-label') ?? control.getAttribute('href')) === key)
        ?.focus({ preventScroll: true });
    }
  }
}

async function followSales(state, signal) {
  while (!signal.aborted) {
    try {
      const { salesVersion } = await api(`admin/sales-updates?since=${state.data.salesVersion}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (signal.aborted || salesVersion === state.data.salesVersion) continue;
      const data = await api(adminSalesPath(state), { signal });
      if (signal.aborted || BigInt(data.salesVersion) <= BigInt(state.data.salesVersion)) continue;
      state.data = data;
      renderSalesUpdate(state);
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 401 || error.status === 403) return navigate(loginUrl('admin'), { replace: true });
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

function syncSalesWatch() {
  salesWatch?.abort();
  salesWatch = null;
  if (!current?.data?.salesVersion || document.hidden) return;
  salesWatch = new AbortController();
  followSales(current, salesWatch.signal);
}

async function loadPage(focus = false) {
  const requestVersion = ++version;
  salesWatch?.abort();
  salesWatch = null;
  const state = { ...route(), search: '' };
  root.setAttribute('aria-busy', 'true');
  try {
    const [system, session] = await Promise.all([status ?? api('status'), api('session')]);
    if (requestVersion !== version) return;
    status = system;
    state.session = session.session;
    if (!state.role) {
      root.innerHTML = notice('Page not found', 'That page is unavailable.', `<a class="btn primary" href="${routeHref('/')}">Open sign-in</a>`);
      return;
    }
    if (state.type === 'login' || state.type === 'recovery') {
      if (state.type === 'login' && state.session?.role === state.role) return navigate(landingUrl(state.role), { replace: true });
      if (state.role === 'staff') state.branches = (await api('branches')).branches;
      if (requestVersion !== version) return;
      root.innerHTML = loginPage(state);
    } else {
      if (state.session?.role !== state.role) return navigate(loginUrl(state.role), { replace: true });
      if (state.type === 'dashboard') root.innerHTML = shell(state, dashboard(state));
      else {
        if (current?.type !== state.type || current?.kind !== state.kind || !root.querySelector('.workspace-content')) root.innerHTML = shell(state, loader);
        const query = `?month=${state.month}`;
        if (state.type === 'register') state.data = await api(`registers/${state.kind}${query}`);
        if (state.type === 'overview' || state.type === 'detail') state.data = await api(adminSalesPath(state));
        if (state.type === 'branches') state.data = await api('admin/branches');
        if (requestVersion !== version) return;
        const views = { register: registerView, detail: registerView, overview, branches: manageBranches };
        root.innerHTML = shell(state, views[state.type](state));
      }
    }
    current = state;
    syncSalesWatch();
    const title = root.querySelector('main h1, main h2')?.textContent;
    document.title = `${title ?? 'Sales System'} | Capitalbet`;
    if (focus) root.querySelector('main h1[tabindex], .login-card h2')?.focus({ preventScroll: true });
  } catch (error) {
    if (requestVersion !== version) return;
    if (supabaseApi && ['login', 'recovery'].includes(state.type)) {
      current = state;
      root.innerHTML = loginPage({ ...state, offline: 'The sign-in service is unavailable. Try again in a moment.' });
      return;
    }
    if (error.status === 401) return navigate(loginUrl(state.role), { replace: true });
    const panel = notice(error.status === 404 ? 'Page not found' : 'Unable to load this page', escapeHtml(error.message),
      state.type === 'detail' && error.status === 404 ? `<a class="btn primary" href="${routeHref(overviewUrl(state.month, state.kind))}">Sales overview</a>` : '<button class="btn primary" data-action="retry">Try again</button>');
    current = state;
    root.innerHTML = state.session?.role === state.role && !['login', 'recovery'].includes(state.type) ? shell(state, panel) : panel;
  } finally {
    if (requestVersion === version) root.removeAttribute('aria-busy');
  }
}

function dialogContent(title, description, contents) {
  editor.setAttribute('aria-labelledby', 'editor-title');
  editor.innerHTML = `<div class="dialog-heading"><div><h2 id="editor-title">${title}</h2><p>${description}</p></div>
    <button type="button" class="icon-btn" aria-label="Close dialog" data-action="close">${icon('close', 21)}</button></div>${contents}`;
  if (!editor.open) editor.showModal();
}

function editorActions(label) {
  return `${errorBox}<div class="dialog-actions"><button class="btn secondary" type="button" data-action="close">Cancel</button><button class="btn primary" type="submit">${label}</button></div>`;
}

function staffEntryDays({ month, data }) {
  const currentDay = today();
  const locked = new Set(data.records.filter(record => record.day < currentDay).map(record => record.day));
  return daysInMonth(month).filter(day => !locked.has(day));
}

function entryEditor(day, available) {
  const { kind, data } = current;
  const record = data.records.find(entry => entry.day === day);
  if (current.type === 'register' && record && day < today()) {
    notify('This day’s entry is locked. Ask an administrator to correct it.', false);
    return;
  }
  if (current.type === 'detail' && !record) return;
  const priorBalance = data.records.reduce((balance, entry) => entry.day < day ? balance + entry.values.balance : balance, data.totals.openingBalance);
  const dailyMovement = record?.values.balance ?? 0;
  const date = available ? `<label for="entry-day">Entry date</label><select id="entry-day" name="day">${available.map(value => `<option value="${value}" ${value === day ? 'selected' : ''}>${dateName(value)}</option>`).join('')}</select>` : '';
  const fields = registers[kind].fields.map(([key, label]) => {
    const value = record?.values[key];
    if (key === 'tickets') return `<label>${label}<input name="${key}" type="number" step="1" min="0" max="1000000000" inputmode="numeric" value="${value ?? ''}" placeholder="0"></label>`;
    return `<label>${label}<span class="money-input"><span class="money-prefix">UGX</span><input name="${key}" data-money type="text" inputmode="decimal" maxlength="24" value="${value === undefined ? '' : number(value)}" placeholder="0"></span></label>`;
  }).join('');
  dialogContent(record ? 'Edit daily entry' : 'Add daily entry', `${registers[kind].title} · ${dateName(day)}`,
    `<form data-form="entry" data-day="${day}" data-revision="${record?.revision ?? 0}" data-prior-balance="${priorBalance}" class="stack-form dialog-form">${date}
      <div class="entry-grid">${fields}</div>
      <div class="entry-movement"><span>${todaysCashAtHandLabel}</span><output data-movement>${money(dailyMovement)}</output></div>
      <div class="balance-preview"><span>Running balance</span><output data-running-balance>${money(priorBalance + dailyMovement)}</output></div>
      <button type="button" class="row-btn reload-entry" data-action="reload-entry" hidden>Load latest entry</button>${editorActions('Save entry')}</form>`);
  editor.querySelector(available ? '#entry-day' : '.entry-grid input').focus();
}

function branchEditor(branch) {
  const editing = Boolean(branch);
  const name = editing ? '' : '<label for="branch-name">Branch name</label><input id="branch-name" name="name" required minlength="2" maxlength="90" placeholder="Enter branch name">';
  const label = editing ? 'New staff PIN' : 'Staff PIN';
  const required = status.managedPins ? '' : 'required';
  const pin = `<label for="new-pin">${label}</label><input id="new-pin" name="pin" type="password" inputmode="numeric" autocomplete="new-password" minlength="${status.pinLength}" maxlength="12" pattern="[0-9]{${status.pinLength},12}" placeholder="${status.pinLength} to 12 digits" ${required}>
    <label for="confirm-pin">Confirm staff PIN</label><input id="confirm-pin" name="confirmation" type="password" inputmode="numeric" autocomplete="new-password" minlength="${status.pinLength}" maxlength="12" pattern="[0-9]{${status.pinLength},12}" ${required}>`;
  const fields = status.managedPins ? `<details class="pin-options"><summary>Set a custom PIN</summary><div class="stack-form">${pin}</div></details>` : pin;
  const description = editing ? `${branchName(branch.name)} · Changing the PIN signs out current staff sessions.` : status.managedPins ? 'Create a branch with a randomly generated staff PIN.' : 'Create a branch and set its first staff sign-in PIN.';
  const title = status.managedPins ? 'Reset staff PIN' : branch?.pinSet ? 'Change staff PIN' : 'Set staff PIN';
  dialogContent(editing ? title : 'Add branch', description,
    `<form data-form="${editing ? 'pin' : 'branch'}" ${editing ? `data-id="${branch.id}"` : ''} class="stack-form dialog-form">${name}${fields}${editorActions(editing ? (status.managedPins ? 'Reset PIN' : 'Save PIN') : 'Create branch')}</form>`);
  editor.querySelector(status.managedPins && editing ? 'summary' : 'input').focus();
}

function amountsFor(form, kind) {
  return Object.fromEntries(registers[kind].fields.map(([key]) => {
    const value = form.elements[key].value;
    return [key, key === 'tickets' ? Number(value) : parseMoneyInput(value)];
  }));
}

function formatMoneyField(input, inputType) {
  const fromClipboard = inputType === 'insertFromPaste' || inputType === 'insertFromDrop';
  const formatted = fromClipboard && Number.isNaN(parseMoneyInput(input.value)) ? input.value : groupMoneyInput(input.value);
  if (formatted !== input.value) {
    let remaining = input.value.slice(input.selectionStart).replaceAll(',', '').trimEnd().length;
    let caret = formatted.length;
    while (remaining > 0 && caret > 0) {
      if (formatted[--caret] !== ',') remaining--;
    }
    if (inputType === 'deleteContentBackward' && formatted[caret - 1] === ',') caret--;
    input.value = formatted;
    input.setSelectionRange(caret, caret);
  }
  input.setCustomValidity(Number.isNaN(parseMoneyInput(input.value)) ? 'Enter an amount between UGX 0 and UGX 999,999,999.99 with up to two decimal places.' : '');
}

function showError(form, message) {
  const error = form.querySelector('.form-error');
  error.textContent = message;
  error.hidden = !message;
}

function notify(message, success = true) {
  window.clearTimeout(toastTimeout);
  toast.className = success ? 'success' : 'failure';
  toast.textContent = message;
  toast.hidden = false;
  toastTimeout = window.setTimeout(() => { toast.hidden = true; }, 4200);
}

function applyPeriod(form) {
  const selected = `${form.elements.year.value}-${form.elements.month.value}`;
  if (!validMonth(selected) || selected === current?.month) return;
  const url = currentAddress();
  url.searchParams.set('month', selected);
  navigate(`${url.pathname}${url.search}`, { focus: false, keepScroll: true });
}

async function submitForm(form) {
  if (form.dataset.form === 'period') return applyPeriod(form);
  const type = form.dataset.form;
  const data = Object.fromEntries(new FormData(form));
  const submit = form.querySelector('button[type="submit"]');
  if (submit.disabled) return;
  const originalLabel = submit.textContent;
  showError(form, '');
  submit.disabled = true;
  submit.textContent = type.endsWith('login') ? 'Signing in…' : 'Saving…';
  try {
    if (type === 'staff-login') {
      await api('login/staff', { method: 'POST', body: { branchId: Number(data.branchId), pin: data.pin } });
      try { localStorage.setItem('capitalbet-branch', data.branchId); } catch { /* Storage may be unavailable. */ }
      await navigate('/dashboard');
    } else if (type === 'admin-login') {
      await api('login/admin', { method: 'POST', body: { password: data.password } });
      await navigate('/admin');
    } else if (type.startsWith('recovery-')) {
      const step = type.slice('recovery-'.length);
      if (step === 'reset' && data.password !== data.confirmation) throw new Error('The passwords must match.');
      const body = step === 'request' ? {} : step === 'verify' ? { code: data.code } : { password: data.password, ...(supabaseApi ? { code: data.code } : {}) };
      await api(`admin/recovery/${step}`, { method: 'POST', body });
      if (!form.isConnected) return;
      if (step === 'reset') {
        notify('Password changed. Sign in with your new password.');
        return navigate('/admin/login', { replace: true });
      }
      current.recoveryStep = step === 'request' && !supabaseApi ? 'verify' : 'reset';
      root.innerHTML = loginPage(current);
      root.querySelector('.login-card input')?.focus();
    } else if (type === 'entry') {
      const state = current;
      const { day, revision } = form.dataset;
      const admin = state.type === 'detail';
      const registerPath = admin ? `admin/branches/${state.id}` : 'registers';
      const entry = await api(`${registerPath}/${state.kind}/${day}`, { method: 'PUT', body: {
        revision: Number(revision), values: amountsFor(form, state.kind),
      } });
      if (current === state) {
        if (!admin || BigInt(entry.salesVersion) >= BigInt(state.data.salesVersion)) state.data = entry;
        if (form.isConnected) editor.close();
        if (admin) renderSalesUpdate(state);
        else root.innerHTML = shell(state, registerView(state));
        root.querySelector(`[data-day="${day}"]`)?.focus({ preventScroll: true });
      }
      notify('Daily entry saved.');
    } else {
      if (data.pin !== data.confirmation) throw new Error('The PINs must match.');
      const state = current;
      if (type === 'branch') await api('admin/branches', { method: 'POST', body: { name: data.name, pin: data.pin } });
      else await api(`admin/branches/${form.dataset.id}/pin`, { method: 'PUT', body: { pin: data.pin } });
      if (current === state) {
        if (form.isConnected) editor.close();
        await loadPage();
      }
      notify(type === 'branch' ? 'Branch created.' : 'Staff PIN updated.');
    }
  } catch (error) {
    if (error.status === 401 && !type.endsWith('login') && !type.startsWith('recovery-')) {
      notify('Your session has ended. Sign in again.', false);
      return navigate(loginUrl(current.role), { replace: true });
    }
    if (form.isConnected) {
      showError(form, error.message);
      if (type === 'entry' && error.status === 409) form.querySelector('.reload-entry').hidden = false;
    }
  } finally {
    submit.disabled = false;
    submit.textContent = originalLabel;
  }
}

document.addEventListener('click', async event => {
  const skip = supabaseApi && event.target.closest('a.skip-link');
  if (skip) {
    event.preventDefault();
    const content = root.querySelector('#main');
    content.tabIndex = -1;
    content.focus();
    return;
  }
  const link = event.target.closest(supabaseApi ? 'a[href^="#/"]' : 'a[href^="/"]');
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
    event.preventDefault();
    await navigate(supabaseApi ? link.getAttribute('href').slice(1) : link.getAttribute('href'));
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  switch (button.dataset.action) {
    case 'retry': return loadPage(true);
    case 'close': return editor.close();
    case 'reveal': {
      const input = button.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${input.name === 'pin' ? 'PIN' : 'password'}`);
      return;
    }
    case 'menu': {
      const open = root.querySelector('.shell').classList.toggle('menu-open');
      button.setAttribute('aria-expanded', String(open));
      return;
    }
    case 'logout': {
      button.disabled = true;
      try {
        await api('logout', { method: 'POST', body: {} });
        await navigate(loginUrl(current.role), { replace: true });
      } catch (error) { notify(error.message, false); }
      finally { button.disabled = false; }
      return;
    }
    case 'pick-entry': {
      const days = staffEntryDays(current);
      if (!days.length) return notify('All entries for this month are locked.', false);
      const date = today();
      const day = days.includes(date) ? date : days.find(value => !current.data.records.some(record => record.day === value)) ?? days[0];
      return entryEditor(day, days);
    }
    case 'edit-entry': return entryEditor(button.dataset.day);
    case 'new-branch': return branchEditor();
    case 'change-pin': return branchEditor(current.data.branches.find(branch => branch.id === Number(button.dataset.id)));
    case 'view-pin': {
      const state = current;
      const branch = state.data.branches.find(item => item.id === Number(button.dataset.id));
      button.disabled = true;
      try {
        const { pin } = await api(`admin/branches/${branch.id}/pin`);
        if (current === state) dialogContent('Staff PIN', branchName(branch.name), `<div class="dialog-form"><output class="revealed-pin">${escapeHtml(pin)}</output><div class="dialog-actions"><button class="btn secondary" data-action="close">Close</button></div></div>`);
      } catch (error) { notify(error.message, false); }
      finally { button.disabled = false; }
      return;
    }
    case 'reload-entry': {
      const { day } = button.form.dataset;
      const chooseDate = Boolean(button.form.elements.day);
      await loadPage();
      if (editor.open && current.data && ['register', 'detail'].includes(current.type)) entryEditor(day, chooseDate ? staffEntryDays(current) : undefined);
      return;
    }
  }
});

document.addEventListener('submit', event => {
  if (!event.target.matches('[data-form]')) return;
  event.preventDefault();
  submitForm(event.target);
});

document.addEventListener('change', event => {
  const form = event.target.form;
  if (form?.dataset.form === 'period' && form.checkValidity()) applyPeriod(form);
  if (event.target.id === 'entry-day') entryEditor(event.target.value, staffEntryDays(current));
});

document.addEventListener('input', event => {
  if (event.target.matches('[data-search]')) {
    current.search = event.target.value;
    const rows = current.type === 'overview' ? salesRows : managedRows;
    const branchRows = root.querySelector('#branch-rows');
    branchRows.innerHTML = rows(current, current.search);
    if (current.type === 'overview') branchRows.closest('.table-scroll').scrollTop = 0;
  }
  const form = event.target.form;
  if (form?.dataset.form === 'entry') {
    if (event.target.matches('[data-money]') && !event.isComposing) formatMoneyField(event.target, event.inputType);
    const { balance } = withBalance(current.kind, amountsFor(form, current.kind));
    form.querySelector('[data-movement]').textContent = Number.isFinite(balance) ? money(balance) : '—';
    form.querySelector('[data-running-balance]').textContent = Number.isFinite(balance) ? money(Number(form.dataset.priorBalance) + balance) : '—';
  }
});

window.addEventListener('popstate', () => {
  if (editor.open) editor.close();
  loadPage(true);
});
document.addEventListener('visibilitychange', () => {
  if (!root.hasAttribute('aria-busy')) syncSalesWatch();
});

loadPage();
