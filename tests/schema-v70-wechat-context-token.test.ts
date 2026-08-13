import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v70-wechat-token-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw Test',
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v70 WeChat context_token persistence', () => {
  test('migrates v69, restores account-scoped rows, claims atomically, and cleans up', () => {
    // Build a realistic v69 predecessor from the previous complete schema,
    // then remove only the v70 table before reopening through the migration.
    db.initDatabase();
    db.closeDatabase();
    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TABLE wechat_context_tokens;
      UPDATE router_state SET value = '69' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('70');
    const account = db.createChannelAccount({
      id: 'wechat-account',
      owner_user_id: 'owner',
      provider: 'wechat',
      name: 'WeChat',
      secret_ref: 'channel-account:wechat-account',
    });
    expect(account.id).toBe('wechat-account');

    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'sensitive-token',
      refreshedAtMs: 1_000,
    });
    expect(db.listWeChatContextTokens(account.id)).toEqual([
      expect.objectContaining({
        user_id: 'peer',
        context_token: 'sensitive-token',
        send_count: 0,
      }),
    ]);

    expect(
      db.claimWeChatContextToken({
        channelAccountId: account.id,
        userId: 'peer',
        expectedToken: 'sensitive-token',
        expectedRefreshedAtMs: 1_000,
        claimCount: 10,
        maxSendCount: 10,
        maxAgeMs: 100_000,
        nowMs: 2_000,
      }),
    ).toMatchObject({ status: 'claimed', record: { send_count: 10 } });
    expect(
      db.claimWeChatContextToken({
        channelAccountId: account.id,
        userId: 'peer',
        expectedToken: 'sensitive-token',
        expectedRefreshedAtMs: 1_000,
        claimCount: 1,
        maxSendCount: 10,
        maxAgeMs: 100_000,
        nowMs: 2_001,
      }),
    ).toEqual({ status: 'quota_exhausted' });

    // Replaying the same inbound batch after a cursor-persistence crash must
    // not reset quota and permit more than ten downstream calls.
    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'replayed-token',
      refreshedAtMs: 1_000,
    });
    expect(db.listWeChatContextTokens(account.id)[0]).toMatchObject({
      context_token: 'sensitive-token',
      send_count: 10,
    });

    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'fresh-token',
      refreshedAtMs: 3_000,
    });
    expect(db.listWeChatContextTokens(account.id)[0]).toMatchObject({
      context_token: 'fresh-token',
      send_count: 0,
    });

    db.closeDatabase();
    db.initDatabase();
    expect(db.listWeChatContextTokens(account.id)).toHaveLength(1);
    expect(db.deleteChannelAccount(account.id, 'owner')).toBe(true);
    expect(db.listWeChatContextTokens(account.id)).toEqual([]);
  });
});
