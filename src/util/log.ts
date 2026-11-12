import { NetworkError, ServerError } from '@/data/errors';
import { strings } from '@/strings';

/** Debug log of a client operation (Metro console / logcat), tagged with the layer that did it. */
export function logDebug(tag: string, message: string, ...details: unknown[]): void {
  console.log(`[SubTrack] ${tag}: ${message}`, ...details);
}

/** Writes a failed operation to the console with the raw error; the user only sees [friendlyError]. */
export function logError(operation: string, error: unknown): void {
  console.error(`[SubTrack] ${operation} failed:`, error);
}

const FIELD_LABELS: Record<string, string> = {
  name: strings.labelName,
  amount: strings.labelAmount,
  currency: strings.labelCurrency,
  billingCycle: strings.labelBillingCycle,
  nextPaymentDate: strings.labelNextPayment,
  category: strings.labelCategory,
  isActive: strings.labelActive,
  notes: strings.labelNotes,
};

/**
 * A short explanation of [error] for the user, shown under the screen's error title. Raw server,
 * network or database messages are never shown; they are only logged.
 */
export function friendlyError(error: unknown): string {
  if (error instanceof NetworkError) return strings.errorNetwork;
  if (error instanceof ServerError) {
    if (error.status === 404) return strings.errorNotFound;
    if (error.status === 400 && error.fields) {
      const labels = Object.keys(error.fields).map((f) => FIELD_LABELS[f] ?? f);
      return strings.errorRejectedFields(labels.join(', '));
    }
    if (error.status >= 400 && error.status < 500) return strings.errorRejected;
    return strings.errorServer;
  }
  return strings.errorStorage;
}
