import { registers } from './sales.mjs';

const paths = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  slots: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M9 5v14m6-14v14M5.5 10.5h1m0 0-1 2.5m6-2.5h1m0 0-1 2.5m6-2.5h1m0 0-1 2.5"/>',
  live: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  branch: '<path d="M3 9l2-5h14l2 5v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 14v6h14v-6m-9 6v-5h4v5M3 9h18"/>',
  chart: '<path d="M4 4v16h16M8 15l4-4 3 2 5-6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4m-4 4v2"/>',
  user: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2"/>',
  exit: '<path d="M14 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9m2-12 4 4-4 4m4-4H9"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-14 4h2m3 0h2m3 0h1"/>',
  edit: '<path d="m14 6 4 4M4 20l4-.8L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  list: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M8 9h8m-8 4h8m-8 4h5"/>',
  shield: '<path d="M12 22s7-3 7-9V5l-7-3-7 3v8c0 6 7 9 7 9z"/><path d="m9 12 2 2 4-4"/>',
  coins: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
};

export const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`;
const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => escaped[character]);
export const branchLabel = name => name.split(' ').map(word => word === 'HBT' ? word : word[0] + word.slice(1).toLowerCase()).join(' ');
export const branchName = name => escapeHtml(branchLabel(name));

const amountFormat = new Intl.NumberFormat('en-UG', { useGrouping: 'always', maximumFractionDigits: 2 });
export const number = (value, key) => amountFormat.format(key === 'tickets' ? value : value / 100);
export const money = value => `UGX ${number(value)}`;
export const salesFigure = (value, key) => key === 'tickets' ? number(value, key) : money(value);

const moneyInputText = value => value.trim().replace(/^UGX\s*/i, '');

export function groupMoneyInput(value) {
  const raw = moneyInputText(value).replaceAll(',', '');
  if (!/^[0-9]*(?:\.[0-9]*)?$/.test(raw) || (!raw && value.trim())) return value;
  const [whole, fraction] = raw.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function parseMoneyInput(value) {
  if (!value.trim()) return 0;
  const text = moneyInputText(value);
  if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) return NaN;
  const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return amount <= 99_999_999_999 ? amount : NaN;
}

const dateFormat = new Intl.DateTimeFormat('en-UG', { dateStyle: 'long', timeZone: 'UTC' });
const weekFormat = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });
export const dateName = day => dateFormat.format(new Date(`${day}T00:00:00Z`));
export const weekday = day => weekFormat.format(new Date(`${day}T00:00:00Z`));
export const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = month => `${months[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
export const logo = `<span class="logo"><img src="${new URL('./capitalbet-logo.png', import.meta.url).pathname}" alt="Capitalbet" width="597" height="321"></span>`;
export const errorBox = '<p class="form-error" role="alert" hidden></p>';
export const loader = '<div class="loading" role="status" aria-busy="true"><span></span> Loading…</div>';

export function monthPicker(month) {
  return `<form class="period" data-form="period" aria-label="Reporting period">
    ${icon('calendar', 19)}<label class="sr-only" for="period-month">Month</label>
    <select id="period-month" name="month">${months.map((name, index) => `<option value="${String(index + 1).padStart(2, '0')}" ${index + 1 === Number(month.slice(5)) ? 'selected' : ''}>${name}</option>`).join('')}</select>
    <label class="sr-only" for="period-year">Year</label>
    <input id="period-year" name="year" type="number" min="1900" max="2999" required value="${month.slice(0, 4)}">
    <button type="submit" class="sr-only">Apply period</button>
  </form>`;
}

export function pageHeading(heading, description, action = '') {
  return `<div class="page-heading"><div><h1 tabindex="-1">${heading}</h1><p>${description}</p></div>${action}</div>`;
}

export function notice(heading, message, action = '') {
  return `<section class="notice panel"><span class="notice-icon">${icon('list', 26)}</span><h1 tabindex="-1">${heading}</h1><p>${message}</p>${action}</section>`;
}

export function searchInput(label, value = '') {
  return `<label class="search">${icon('search', 18)}<span class="sr-only">${label}</span><input data-search type="search" placeholder="${label}" value="${escapeHtml(value)}" autocomplete="off"></label>`;
}

export function fieldList(kind) {
  return [['balance', 'Balance'], ...registers[kind].fields];
}
