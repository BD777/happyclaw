import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-system-settings-security-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    DATA_DIR: tmpDir,
    STORE_DIR: path.join(tmpDir, 'db'),
    GROUPS_DIR: path.join(tmpDir, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'settings-security-user',
        username: 'settings-security-user',
        display_name: 'Settings Security User',
        role: process.env.HAPPYCLAW_TEST_ROLE ?? 'member',
        status: 'active',
        permissions: JSON.parse(process.env.HAPPYCLAW_TEST_PERMISSIONS ?? '[]'),
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const stopGroup = vi.fn(async () => {});
const app = web.createAppForTest({
  queue: {
    stopGroup,
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 'test-pause' }),
    resumeGroupsAfterMutation: vi.fn(),
  },
  getRegisteredGroups: () => ({}),
} as any);

function asUser(role: 'admin' | 'member', permissions: string[] = []): void {
  process.env.HAPPYCLAW_TEST_ROLE = role;
  process.env.HAPPYCLAW_TEST_PERMISSIONS = JSON.stringify(permissions);
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  delete process.env.HAPPYCLAW_TEST_ROLE;
  delete process.env.HAPPYCLAW_TEST_PERMISSIONS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('system settings capability boundaries', () => {
  test('system config response excludes host and billing fields', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('externalClaudeDir');
    expect(body).not.toHaveProperty('pluginAutoScan');
    expect(body).not.toHaveProperty('adminHostOnlyMode');
    expect(body).not.toHaveProperty('mainAgentContextSource');
    expect(body).not.toHaveProperty('mainAgentAutoCompactWindow');
    expect(body).not.toHaveProperty('mainAgentAutoCompactPercentage');
    expect(body).not.toHaveProperty('billingEnabled');
    expect(body).not.toHaveProperty('billingCurrencyRate');
  });

  test('system config rejects billing fields instead of silently accepting them', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ billingEnabled: true }),
    });
    expect(response.status).toBe(400);
  });

  test('stale clients may submit retired automation fields, which are ignored', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxConcurrentScripts: 100,
        scriptTimeout: -1,
        taskBackfillGraceMs: 'legacy',
        maxRepliesPerTurn: null,
        maxTasksPerUser: 999_999,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('maxConcurrentScripts');
    expect(body).not.toHaveProperty('scriptTimeout');
    expect(body).not.toHaveProperty('taskBackfillGraceMs');
    expect(body).not.toHaveProperty('maxRepliesPerTurn');
    expect(body).not.toHaveProperty('maxTasksPerUser');
  });

  test('member with system permission cannot read or write host integration', async () => {
    asUser('member', ['manage_system_config']);
    expect((await app.request('/api/config/host-integration')).status).toBe(
      403,
    );
    expect(
      (
        await app.request('/api/config/host-integration', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ externalClaudeDir: tmpDir }),
        })
      ).status,
    ).toBe(403);
  });

  test('admin host update logs names but never the sensitive path', async () => {
    asUser('admin');
    const response = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'settings-security-test',
      },
      body: JSON.stringify({
        externalClaudeDir: tmpDir,
        mainAgentContextSource: 'managed',
      }),
    });
    expect(response.status).toBe(200);
    const logs = db.queryAuthAuditLogs({
      event_type: 'host_integration_updated',
    }).logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({
      changed_fields: ['externalClaudeDir', 'mainAgentContextSource'],
      external_claude_dir_configured: true,
    });
    expect(JSON.stringify(logs[0].details)).not.toContain(tmpDir);
  });

  test('combined host and compact update quiesces admin custom and member default workspaces without discarding work', async () => {
    const now = new Date().toISOString();
    for (const [id, role] of [
      ['settings-admin-owner', 'admin'],
      ['settings-member-owner', 'member'],
    ] as const) {
      db.createUser({
        id,
        username: id,
        password_hash: 'hash',
        display_name: id,
        role,
        status: 'active',
        created_at: now,
        updated_at: now,
        must_change_password: false,
      });
    }
    const adminCustom = db.createAgentProfile({
      ownerUserId: 'settings-admin-owner',
      name: 'Admin Custom Host',
      runtimePolicy: { context: { source: 'host_claude' } },
    });
    db.getOrCreateDefaultAgentProfile('settings-member-owner');
    db.setRegisteredGroup('web:settings-admin-custom', {
      name: 'Admin custom',
      folder: 'settings-admin-custom',
      added_at: now,
      executionMode: 'host',
      created_by: 'settings-admin-owner',
    });
    db.assignWorkspaceAgentProfile('settings-admin-custom', adminCustom.id);
    db.setSession('settings-admin-custom', 'sdk-session-dir-a', null, {
      agentProfileId: adminCustom.id,
      agentProfileVersion: adminCustom.version,
      identityHash: adminCustom.identity_hash,
    });
    expect(db.getSession('settings-admin-custom')).toBe('sdk-session-dir-a');
    expect(
      db.listWorkspaceRuntimeSessionsByWorkspace('web:settings-admin-custom'),
    ).toHaveLength(1);
    db.setRegisteredGroup('web:settings-member-default', {
      name: 'Member default',
      folder: 'settings-member-default',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-member-owner',
    });

    const nextClaudeDir = path.join(tmpDir, 'next-claude');
    fs.mkdirSync(nextClaudeDir);
    stopGroup.mockClear();
    asUser('admin');
    const response = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalClaudeDir: nextClaudeDir,
        mainAgentAutoCompactWindow: 360_000,
      }),
    });
    expect(response.status).toBe(200);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:settings-admin-custom',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );
    expect(stopGroup).toHaveBeenCalledWith(
      'web:settings-member-default',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );
    expect(db.getSession('settings-admin-custom')).toBeUndefined();
    expect(
      db.listWorkspaceRuntimeSessionsByWorkspace('web:settings-admin-custom'),
    ).toEqual([]);

    db.setSession('settings-admin-custom', 'sdk-session-dir-b', null, {
      agentProfileId: adminCustom.id,
      agentProfileVersion: adminCustom.version,
      identityHash: adminCustom.identity_hash,
    });
    const finalClaudeDir = path.join(tmpDir, 'final-claude');
    fs.mkdirSync(finalClaudeDir);
    const secondResponse = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalClaudeDir: finalClaudeDir }),
    });
    expect(secondResponse.status).toBe(200);
    expect(db.getSession('settings-admin-custom')).toBeUndefined();
    expect(
      db.listWorkspaceRuntimeSessionsByWorkspace('web:settings-admin-custom'),
    ).toEqual([]);
  });

  test('admin host-only mode migrates only active-admin runtimes and preserves member isolation', async () => {
    const now = new Date().toISOString();
    db.setRegisteredGroup('web:settings-admin-container', {
      name: 'Admin container before policy',
      folder: 'settings-admin-container',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-admin-owner',
    });
    db.setRegisteredGroup('web:settings-member-container', {
      name: 'Member container before policy',
      folder: 'settings-member-container',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-member-owner',
    });
    db.createTask({
      id: 'settings-admin-container-task',
      group_folder: 'settings-admin-container',
      chat_jid: 'web:settings-admin-container',
      prompt: 'admin policy migration',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: now,
      created_by: 'settings-admin-owner',
      notify_channels: null,
    });
    db.createTask({
      id: 'settings-member-container-task',
      group_folder: 'settings-member-container',
      chat_jid: 'web:settings-member-container',
      prompt: 'member remains isolated',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: now,
      created_by: 'settings-member-owner',
      notify_channels: null,
    });

    stopGroup.mockClear();
    asUser('admin');
    const response = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ adminHostOnlyMode: true });
    expect(
      db.getRegisteredGroup('web:settings-admin-container')?.executionMode,
    ).toBe('host');
    expect(
      db.getTaskById('settings-admin-container-task')?.execution_mode,
    ).toBe('host');
    expect(
      db.getRegisteredGroup('web:settings-member-container')?.executionMode,
    ).toBe('container');
    expect(
      db.getTaskById('settings-member-container-task')?.execution_mode,
    ).toBe('container');
    expect(stopGroup).toHaveBeenCalledWith(
      'web:settings-admin-container',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );

    const disableResponse = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: false }),
    });
    expect(disableResponse.status).toBe(200);
    expect(
      db.getRegisteredGroup('web:settings-admin-container')?.executionMode,
    ).toBe('host');
  });
});

describe('billing config capability boundary', () => {
  test('manage_system_config alone cannot access billing admin config', async () => {
    asUser('member', ['manage_system_config']);
    expect((await app.request('/api/billing/admin/config')).status).toBe(403);
  });

  test('manage_billing can update config and produces billing audit', async () => {
    asUser('member', ['manage_billing']);
    const response = await app.request('/api/billing/admin/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        minStartBalanceUsd: 1.5,
        currency: 'CNY',
        currencyRate: 7.2,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      minStartBalanceUsd: 1.5,
      currency: 'CNY',
      currencyRate: 7.2,
    });
    const logs = db.getBillingAuditLog(
      20,
      0,
      'settings-security-user',
      'billing_settings_updated',
    ).logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toEqual({
      changed_fields: [
        'currency',
        'currencyRate',
        'enabled',
        'minStartBalanceUsd',
      ],
    });
  });
});
