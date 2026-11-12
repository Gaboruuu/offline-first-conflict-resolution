import { strings } from '@/strings';
import { daysBetween, formatDate, todayIso } from './dates';

/** Payments due within this many days are highlighted in the list. */
export const DUE_SOON_DAYS = 3;

/** e.g. `due tomorrow`, `due in 3 days`, or the date itself when it is further away. */
export function dueText(nextPaymentDate: string, today: string = todayIso()): string {
  const days = daysBetween(today, nextPaymentDate);
  if (days < 0) return strings.overdue;
  if (days === 0) return strings.dueToday;
  if (days === 1) return strings.dueTomorrow;
  if (days <= DUE_SOON_DAYS) return strings.dueInDays(days);
  return formatDate(nextPaymentDate);
}
