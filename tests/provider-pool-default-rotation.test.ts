import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-default-rotation-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const { trySelectPoolProvider } = await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * An auto-resolved defaultProviderId must not disable the balancing pool.
 *
 * resolveDefaultProviderId() falls back to the first enabled provider, so every
 * installation has a default. If that counted as a pin, a multi-account pool
 * would send every session to the same provider — and, because the pinned path
 * skips the health check, keep sending them there after that account hit its
 * limit.
 */
describe('default model configuration vs. balancing pool', () => {
  const created: string[] = [];

  beforeAll(() => {
    for (const name of ['Account A', 'Account B', 'Account C']) {
      created.push(
        runtimeConfig.createProvider({
          name,
          type: 'official',
          anthropicApiKey: `${name.replace(/\s+/g, '-').toLowerCase()}-key`,
          anthropicModel: 'claude-fable-5',
          enabled: true,
        }).id,
      );
    }
  });

  test('a default is still auto-resolved for display and single-provider use', () => {
    expect(runtimeConfig.getDefaultProviderId()).toBe(created[0]);
  });

  test('rotates across enabled providers when no Agent pinned a configuration', () => {
    const picked = new Set<string>();
    // Distinct groupFolders: each is a fresh session, so sticky binding never
    // applies and every call is a real pool selection.
    for (let i = 0; i < 12; i += 1) {
      const result = trySelectPoolProvider(`rotation-group-${i}`, null, null);
      expect(result).not.toBeNull();
      picked.add(result!.profileId);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  test('an explicit Agent model configuration still pins selection', () => {
    for (let i = 0; i < 5; i += 1) {
      const result = trySelectPoolProvider(
        `pinned-group-${i}`,
        null,
        created[2],
      );
      expect(result?.profileId).toBe(created[2]);
    }
  });

  test('a single enabled provider still resolves through the default', () => {
    runtimeConfig.setProviderEnabled(created[1], false);
    runtimeConfig.setProviderEnabled(created[2], false);
    const result = trySelectPoolProvider('single-provider-group', null, null);
    expect(result?.profileId).toBe(created[0]);
    runtimeConfig.setProviderEnabled(created[1], true);
    runtimeConfig.setProviderEnabled(created[2], true);
  });

  /**
   * A sticky binding quarantined long ago must be reused once the recovery
   * interval has elapsed. selectProvider() applies the time-based recovery
   * rule internally, but the sticky-health read happens before that call, so
   * without an explicit refresh a long-idle group keeps switching away from a
   * provider that recovered ages ago — clearing the session and reinjecting
   * history for nothing.
   */
  test('sticky binding is reused after the recovery interval expires', () => {
    vi.useFakeTimers();
    try {
      // failover makes the no-sticky fallback deterministic: it would always
      // pick created[0], so reuse of created[2] can only come from stickiness.
      runtimeConfig.saveBalancingConfig({
        strategy: 'failover',
        recoveryIntervalMs: 300_000,
      });

      db.setSessionProviderId('sticky-quarantine-group', null, created[2]);
      providerPool.reportFailure(created[2], true);

      const during = trySelectPoolProvider(
        'sticky-quarantine-group',
        null,
        null,
      );
      expect(during?.profileId).toBe(created[0]);
      expect(during?.resetSession).toBe(true);

      db.setSessionProviderId('sticky-recovered-group', null, created[2]);
      vi.setSystemTime(Date.now() + 300_000 + 1);

      const after = trySelectPoolProvider('sticky-recovered-group', null, null);
      expect(after?.profileId).toBe(created[2]);
      expect(after?.resetSession ?? false).toBe(false);
    } finally {
      vi.useRealTimers();
      runtimeConfig.saveBalancingConfig({ strategy: 'round-robin' });
    }
  });
});
