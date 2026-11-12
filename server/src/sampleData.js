/** Demo subscriptions stored when the server starts without a data file. */
export function sampleData(now) {
  const iso = (date) => date.toISOString().slice(0, 10);
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const inDays = (days) => iso(new Date(today.getTime() + days * 24 * 60 * 60 * 1000));
  const inMonths = (months) => {
    const date = new Date(today);
    date.setUTCMonth(date.getUTCMonth() + months);
    return iso(date);
  };
  const base = { currency: 'RON', billingCycle: 'MONTHLY', isActive: true, notes: '' };
  return [
    { ...base, name: 'Netflix', amount: 49.99, nextPaymentDate: inDays(2), category: 'ENTERTAINMENT', notes: 'Shared with my sister' },
    { ...base, name: 'Spotify', amount: 25.99, nextPaymentDate: inDays(6), category: 'ENTERTAINMENT', notes: 'Student discount until June' },
    { ...base, name: 'Gym membership', amount: 150, nextPaymentDate: inDays(9), category: 'HEALTH_FITNESS' },
    { ...base, name: 'Phone plan', amount: 45, nextPaymentDate: inDays(14), category: 'UTILITIES' },
    { ...base, name: 'Language course', amount: 30, billingCycle: 'WEEKLY', nextPaymentDate: inDays(1), category: 'EDUCATION', isActive: false, notes: 'Paused for the summer' },
    { ...base, name: 'Cloud storage', amount: 50, currency: 'EUR', billingCycle: 'YEARLY', nextPaymentDate: inMonths(5), category: 'WORK' },
  ];
}
