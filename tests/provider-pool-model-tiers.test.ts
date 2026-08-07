import { describe, expect, test, vi } from 'vitest';

import { ProviderPool } from '../src/provider-pool.js';

const ACCOUNTS = [
  { id: 'acct-1', enabled: true, weight: 1 },
  { id: 'acct-2', enabled: true, weight: 1 },
  { id: 'acct-3', enabled: true, weight: 1 },
];

const BALANCING = {
  strategy: 'round-robin' as const,
  unhealthyThreshold: 1,
  recoveryIntervalMs: 300_000,
};

function primaryTier(model = 'fable'): Map<string, string> {
  return new Map(ACCOUNTS.map((a) => [a.id, model]));
}

function makePool(balancing: Partial<typeof BALANCING> = {}): ProviderPool {
  const pool = new ProviderPool();
  pool.refreshFromConfig(ACCOUNTS, { ...BALANCING, ...balancing });
  return pool;
}

describe('per-account model tier quarantine', () => {
  test('a walled model tier does not take the account out of rotation', () => {
    const pool = makePool();
    pool.reportModelFailure('acct-1', 'fable');

    // The account itself is untouched: its other tiers still work.
    expect(pool.getHealthStatus('acct-1').healthy).toBe(true);
    expect(pool.isModelQuarantined('acct-1', 'fable')).toBe(true);
    expect(pool.isModelQuarantined('acct-1', 'claude-opus-5')).toBe(false);
    expect(pool.hasCandidateForTier('claude-opus-5')).toBe(true);
  });

  test('the primary tier drains across every account before escalating', () => {
    const pool = makePool();

    // Two accounts walled on fable — the third still serves the primary tier.
    pool.reportModelFailure('acct-1', 'fable');
    pool.reportModelFailure('acct-2', 'fable');
    expect(pool.hasCandidateForTier(primaryTier())).toBe(true);
    expect(pool.selectProvider(primaryTier())).toBe('acct-3');

    // Only once every account is walled does the primary tier count as gone.
    pool.reportModelFailure('acct-3', 'fable');
    expect(pool.hasCandidateForTier(primaryTier())).toBe(false);
    expect(pool.hasCandidateForTier('claude-opus-5')).toBe(true);
  });

  test('an account walled on one tier is still selectable on another', () => {
    const pool = makePool();
    for (const a of ACCOUNTS) pool.reportModelFailure(a.id, 'fable');

    expect(pool.hasCandidateForTier(primaryTier())).toBe(false);
    // Every account remains eligible for the escalated tier.
    const picked = new Set([
      pool.selectProvider('claude-opus-5'),
      pool.selectProvider('claude-opus-5'),
      pool.selectProvider('claude-opus-5'),
    ]);
    expect(picked).toEqual(new Set(['acct-1', 'acct-2', 'acct-3']));
  });

  test('an account-scope wall removes the account from every tier', () => {
    const pool = makePool();
    pool.reportFailure('acct-1', true);

    expect(pool.hasCandidateForTier(primaryTier())).toBe(true);
    expect(pool.selectProvider(primaryTier())).not.toBe('acct-1');
    expect(pool.selectProvider('claude-opus-5')).not.toBe('acct-1');
  });

  test('a tier quarantine honours the upstream reset over the interval', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-07T08:00:00.000Z'));
      const pool = makePool();
      const resetsAt = new Date('2026-08-07T16:00:00.000Z').getTime();
      pool.reportModelFailure('acct-1', 'fable', resetsAt);

      vi.advanceTimersByTime(300_000);
      expect(pool.isModelQuarantined('acct-1', 'fable')).toBe(true);

      vi.setSystemTime(new Date(resetsAt));
      expect(pool.isModelQuarantined('acct-1', 'fable')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a completed turn clears the tier it ran on', () => {
    const pool = makePool();
    pool.reportModelFailure('acct-1', 'fable');
    pool.reportSuccess('acct-1', 'fable');
    expect(pool.isModelQuarantined('acct-1', 'fable')).toBe(false);
  });
});

describe('rotation strategy', () => {
  test('round-robin strategies rotate per request', () => {
    for (const strategy of ['round-robin', 'weighted-round-robin'] as const) {
      const pool = makePool({ strategy });
      expect(pool.rotatesPerRequest).toBe(true);
      expect([
        pool.selectProvider(),
        pool.selectProvider(),
        pool.selectProvider(),
      ]).toEqual(['acct-1', 'acct-2', 'acct-3']);
    }
  });

  test('failover stays on one account until it fails', () => {
    const pool = makePool({ strategy: 'failover' });
    expect(pool.rotatesPerRequest).toBe(false);
    expect([pool.selectProvider(), pool.selectProvider()]).toEqual([
      'acct-1',
      'acct-1',
    ]);

    pool.reportFailure('acct-1', true);
    expect(pool.selectProvider()).toBe('acct-2');
  });
});
