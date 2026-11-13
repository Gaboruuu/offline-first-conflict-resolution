import type { Env, ScalarFields } from '../src/index';

export const NETFLIX: ScalarFields = {
  name: 'Netflix',
  amountCents: 4999,
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-12-01',
  category: 'Streaming',
  isActive: true,
  notes: '',
};

export const ID_A = '00000000-0000-4000-8000-00000000000a';
export const ID_B = '00000000-0000-4000-8000-00000000000b';

/** A test Env whose clock is set by hand; `newId` returns id-1, id-2, ... */
export interface ManualEnv {
  env: Env;
  set(t: number): void;
  tick(ms?: number): void;
}

export function manualEnv(start = 1_000): ManualEnv {
  let t = start;
  let ids = 0;
  return {
    env: { now: () => t, newId: () => `id-${++ids}` },
    set: (v: number) => {
      t = v;
    },
    tick: (ms = 1) => {
      t += ms;
    },
  };
}
