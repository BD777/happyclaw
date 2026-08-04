import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v69-agent-effort-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const createdAt = '2026-08-01T00:00:00.000Z';
const legacyPolicy = {
  context: {
    source: 'managed',
    auto_compact_window: 0,
    auto_compact_percentage: 0,
  },
  skills: { mode: 'inherit', ids: [] },
  mcp: { mode: 'inherit', ids: [] },
};
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '68');
  CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    identity_prompt TEXT NOT NULL DEFAULT '',
    soul_prompt TEXT NOT NULL DEFAULT '',
    agents_prompt TEXT NOT NULL DEFAULT '',
    tools_prompt TEXT NOT NULL DEFAULT '',
    prompt_mode TEXT NOT NULL DEFAULT 'append',
    include_claude_preset INTEGER NOT NULL DEFAULT 1,
    avatar_emoji TEXT,
    avatar_color TEXT,
    avatar_url TEXT,
    model_config_id TEXT,
    runtime_policy TEXT NOT NULL DEFAULT '{}',
    identity_hash TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
legacy
  .prepare(
    `INSERT INTO agent_profiles (
       id, owner_user_id, name, runtime_policy, identity_hash, version,
       is_default, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    'legacy-agent',
    'legacy-user',
    'Legacy Agent',
    JSON.stringify(legacyPolicy),
    'legacy-hash',
    7,
    1,
    createdAt,
    createdAt,
  );
legacy.close();

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v69 Agent effort migration', () => {
  test('backfills inherit without changing Agent identity metadata', () => {
    db.initDatabase();

    const profile = db.getAgentProfile('legacy-agent');
    expect(profile?.runtime_policy.reasoning).toEqual({ effort: 'inherit' });
    expect(profile).toMatchObject({
      version: 7,
      identity_hash: 'legacy-hash',
      updated_at: createdAt,
    });

    const probe = new Database(databasePath, { readonly: true });
    const stored = probe
      .prepare(
        'SELECT runtime_policy, version, identity_hash, updated_at FROM agent_profiles WHERE id = ?',
      )
      .get('legacy-agent') as {
      runtime_policy: string;
      version: number;
      identity_hash: string;
      updated_at: string;
    };
    expect(JSON.parse(stored.runtime_policy).reasoning).toEqual({
      effort: 'inherit',
    });
    expect(stored).toMatchObject({
      version: 7,
      identity_hash: 'legacy-hash',
      updated_at: createdAt,
    });
    probe.close();
  });
});
