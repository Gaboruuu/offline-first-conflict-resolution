/** A recurring payment tracked by the app. Dates are ISO local dates (`YYYY-MM-DD`). */
export interface Subscription {
  readonly id: number;
  readonly name: string;
  readonly amount: number;
  readonly currency: string;
  readonly billingCycle: BillingCycle;
  readonly nextPaymentDate: string;
  readonly category: Category;
  readonly isActive: boolean;
  readonly notes: string;
}

/** A subscription that has not been stored yet, so it has no id. */
export type NewSubscription = Omit<Subscription, 'id'>;

export type BillingCycle = 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export type Category = 'ENTERTAINMENT' | 'UTILITIES' | 'HEALTH_FITNESS' | 'EDUCATION' | 'WORK' | 'OTHER';

export const DEFAULT_CURRENCY = 'RON';
export const CURRENCIES = ['RON', 'EUR', 'USD'] as const;
export const MAX_NAME_LENGTH = 50;

export const BILLING_CYCLES: readonly BillingCycle[] = ['WEEKLY', 'MONTHLY', 'YEARLY'];

export const BILLING_CYCLE_INFO: Record<BillingCycle, { label: string; paymentsPerMonth: number }> = {
  WEEKLY: { label: 'Weekly', paymentsPerMonth: 52 / 12 },
  MONTHLY: { label: 'Monthly', paymentsPerMonth: 1 },
  YEARLY: { label: 'Yearly', paymentsPerMonth: 1 / 12 },
};

export const CATEGORIES: readonly Category[] = [
  'ENTERTAINMENT',
  'UTILITIES',
  'HEALTH_FITNESS',
  'EDUCATION',
  'WORK',
  'OTHER',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  ENTERTAINMENT: 'Entertainment',
  UTILITIES: 'Utilities',
  HEALTH_FITNESS: 'Health & Fitness',
  EDUCATION: 'Education',
  WORK: 'Work',
  OTHER: 'Other',
};
