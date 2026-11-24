const cashFields = [
  ['cashIn', 'Cash In'], ['cashOut', 'Cash Out'], ['freeCoupons', 'Free Coupons'],
];

export const registers = {
  slots: {
    title: 'Slots', icon: 'slots',
    description: 'Record and review daily slots sales, cash movements, expenses and free coupons.',
    fields: [
      ['totalIn', 'Total In'], ['totalOut', 'Total Out'], ['expenses', 'Expenses'],
      ...cashFields,
    ],
  },
  live: {
    title: 'Live-in-Play', icon: 'live',
    description: 'Record and review daily live-in-play sales, tickets, cash movements and free coupons.',
    fields: [
      ['totalIn', 'Total In'], ['totalOut', 'Total Out'], ['tickets', 'Number of Tickets Made'],
      ...cashFields,
    ],
  },
};

export const validMonth = month => typeof month === 'string' && /^(19\d{2}|2\d{3})-(0[1-9]|1[0-2])$/.test(month);
export const isRegister = type => Object.hasOwn(registers, type);

const eastAfricaDateParts = new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Africa/Nairobi' });
export function today() {
  const parts = Object.fromEntries(eastAfricaDateParts.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function daysInMonth(month) {
  const [year, index] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return Array.from({ length: days }, (_, day) => `${month}-${String(day + 1).padStart(2, '0')}`);
}

export function withBalance(type, values) {
  const { totalIn, totalOut, cashIn = 0, cashOut = 0, freeCoupons = 0 } = values;
  const expenses = type === 'slots' ? values.expenses : 0;
  const balance = totalIn + cashIn - totalOut - expenses - cashOut - freeCoupons;
  return { ...values, cashIn, cashOut, freeCoupons, balance };
}

export function emptyTotals(type) {
  return Object.fromEntries([['balance', 0], ...registers[type].fields.map(([key]) => [key, 0])]);
}

export function sumTotals(total, values) {
  for (const key of Object.keys(total)) total[key] += values[key];
  return total;
}
