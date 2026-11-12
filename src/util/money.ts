import { BILLING_CYCLE_INFO, Subscription } from '@/model/Subscription';

/** Fixed demo exchange rates (1 unit of currency -> RON). */
const RATES_TO_RON: Record<string, number> = {
  RON: 1,
  EUR: 4.97,
  USD: 4.57,
};

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatMoney(amount: number, currency: string): string {
  return `${roundMoney(amount).toFixed(2)} ${currency}`;
}

/** Amount as shown in the form's input, e.g. `49.99`. */
export function formatAmountInput(amount: number): string {
  return roundMoney(amount).toFixed(2);
}

/** Normalises every active subscription to a monthly amount in RON (yearly ÷ 12, weekly × 52 / 12). */
export function monthlyTotalRon(subscriptions: readonly Subscription[]): number {
  const total = subscriptions
    .filter((s) => s.isActive)
    .reduce((sum, s) => {
      const rate = RATES_TO_RON[s.currency.toUpperCase()] ?? 1;
      return sum + s.amount * rate * BILLING_CYCLE_INFO[s.billingCycle].paymentsPerMonth;
    }, 0);
  return roundMoney(total);
}
