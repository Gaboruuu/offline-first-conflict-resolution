import { getRandomValues as expoGetRandomValues } from 'expo-crypto';

/**
 * Stand-in for `lib0/webcrypto` (used by Yjs for random client ids), whose React Native build needs
 * `isomorphic-webcrypto`. Metro and Jest resolve `lib0/webcrypto` to this file; sync-core's Yjs
 * strategy sets every client id itself, so only `getRandomValues` is ever called.
 */
export const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
  if (array && 'BYTES_PER_ELEMENT' in array) expoGetRandomValues(array as unknown as Uint8Array);
  return array;
};

export const subtle = undefined;
