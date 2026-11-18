import { randomUUID } from 'expo-crypto';

/** A new UUID v4: the id of a subscription or payment, generated on this device. */
export const newId = (): string => randomUUID();
