/** Helpers for ISO local dates (`YYYY-MM-DD`), computed in UTC so time zones and DST never shift a day. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Today's date in the device's time zone. */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && fromUtc(toUtc(value)) === value;
}

export function addDays(iso: string, days: number): string {
  const date = toUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

export function addMonths(iso: string, months: number): string {
  const date = toUtc(iso);
  date.setUTCMonth(date.getUTCMonth() + months);
  return fromUtc(date);
}

/** Whole days from [from] to [to]; negative when [to] is in the past. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / DAY_MS);
}

/** e.g. `07 Oct 2026`, the same format as the mockups. */
export function formatDate(iso: string): string {
  const date = toUtc(iso);
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Converts between ISO dates and the `Date` objects used by the native date picker (local midnight). */
export function isoToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const localDateToIso = todayIso;

/** A moment as `today, 14:32`, `yesterday, 09:05` or `07 Oct 2026, 14:32`, in the device's time zone. */
export function formatSyncTime(
  timestamp: string,
  labels: { today: string; yesterday: string },
  now: Date = new Date(),
): string {
  const date = new Date(timestamp);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = todayIso(date);
  const today = todayIso(now);
  if (day === today) return `${labels.today}, ${time}`;
  if (day === addDays(today, -1)) return `${labels.yesterday}, ${time}`;
  return `${formatDate(day)}, ${time}`;
}
