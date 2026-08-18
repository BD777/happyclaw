import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v73-classifiable-mount-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

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

const now = '2026-08-18T00:00:00.000Z';
const workspaceJid = 'web:legacy-shared-ws';
const legacyFolderJid = 'web:legacy-shared-ws';

const qqDmJid = 'qq:c2c:alice#account:bot-a';
const qqGroupJid = 'qq:group:sales#account:bot-a';
const telegramDmJid = 'telegram:123456#account:bot-a';
const telegramGroupJid = 'telegram:-100123#account:bot-a';
const wechatDmJid = 'wechat:wxid_alice#account:bot-a';
const wecomMigratedJid = 'wecom:c2c:already#account:bot-a';
const wecomLeftoverJid = 'wecom:c2c:leftover#account:bot-a';
const manualDmJid = 'qq:c2c:bob#account:bot-a';
const missingWsDmJid = 'dingtalk:c2c:carol#account:bot-a';
const feishuUnknownJid = 'feishu:oc_opaque#account:bot-a';
const malformedTelegramJid = 'telegram:not-a-number#account:bot-a';

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v73 classifiable direct workspace-mount migration', () => {
  test('moves leftover classifiable DMs off a shared workspace owner and skips groups/manual/unknown', () => {
    db.initDatabase();
    db.setRegisteredGroup(workspaceJid, {
      name: 'Legacy shared workspace',
      folder: 'legacy-shared-ws',
      added_at: now,
      created_by: 'owner-a',
    });
    db.createAgent({
      id: 'manual-session',
      group_folder: 'legacy-shared-ws',
      chat_jid: workspaceJid,
      name: 'Manual QQ DM session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner-a',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: manualDmJid,
      spawned_from_jid: null,
      source_kind: 'manual',
    });
    db.createAgent({
      id: 'wecom-v72-session',
      group_folder: 'legacy-shared-ws',
      chat_jid: workspaceJid,
      name: 'Already migrated WeCom DM',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner-a',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: wecomMigratedJid,
      spawned_from_jid: null,
      source_kind: 'channel_direct',
    });

    db.setRegisteredGroup(qqDmJid, {
      name: 'Alice QQ DM',
      folder: 'qq-alice',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: legacyFolderJid,
    });
    db.setRegisteredGroup(qqGroupJid, {
      name: 'QQ sales group',
      folder: 'qq-sales',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(telegramDmJid, {
      name: 'Telegram DM',
      folder: 'tg-dm',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(telegramGroupJid, {
      name: 'Telegram group',
      folder: 'tg-group',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(wechatDmJid, {
      name: 'WeChat DM',
      folder: 'wechat-alice',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(wecomMigratedJid, {
      name: 'WeCom already migrated',
      folder: 'wecom-already',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_agent_id: 'wecom-v72-session',
    });
    db.setRegisteredGroup(wecomLeftoverJid, {
      name: 'WeCom leftover',
      folder: 'wecom-leftover',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(manualDmJid, {
      name: 'Bob QQ DM',
      folder: 'qq-bob',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_agent_id: 'manual-session',
    });
    db.setRegisteredGroup(missingWsDmJid, {
      name: 'Carol DingTalk DM',
      folder: 'dt-carol',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: 'web:deleted-workspace',
    });
    db.setRegisteredGroup(feishuUnknownJid, {
      name: 'Feishu opaque chat',
      folder: 'feishu-opaque',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(malformedTelegramJid, {
      name: 'Malformed Telegram',
      folder: 'tg-bad',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });

    expect(
      db.setSessionChannelOwnerOnce('legacy-shared-ws', null, qqDmJid),
    ).toBe(qqDmJid);

    const failureInjector = new Database(databasePath);
    failureInjector.exec(`
      CREATE TRIGGER fail_classifiable_direct_mount_update
      BEFORE UPDATE OF target_agent_id ON registered_groups
      WHEN OLD.jid = '${qqDmJid}'
      BEGIN
        SELECT RAISE(ABORT, 'injected migration failure');
      END;
    `);
    failureInjector.close();

    expect(() =>
      db.migrateClassifiableDirectWorkspaceMountsToSessions(),
    ).toThrow('injected migration failure');
    expect(db.getRegisteredGroup(qqDmJid)).toMatchObject({
      target_main_jid: legacyFolderJid,
    });
    expect(
      db
        .listAgentsByJid(workspaceJid)
        .filter(
          (agent) =>
            agent.source_kind === 'channel_direct' &&
            agent.id !== 'wecom-v72-session',
        ),
    ).toHaveLength(0);
    expect(db.getSessionChannelOwner('legacy-shared-ws')).toBe(qqDmJid);

    const triggerCleanup = new Database(databasePath);
    triggerCleanup.exec('DROP TRIGGER fail_classifiable_direct_mount_update');
    triggerCleanup.close();

    expect(db.migrateClassifiableDirectWorkspaceMountsToSessions()).toBe(4);
    expect(db.migrateClassifiableDirectWorkspaceMountsToSessions()).toBe(0);

    const migratedQq = db.getRegisteredGroup(qqDmJid)!;
    expect(migratedQq.target_main_jid).toBeUndefined();
    expect(migratedQq.target_agent_id).toBeTruthy();
    expect(db.getAgent(migratedQq.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );
    expect(db.getChannelMount(qqDmJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: migratedQq.target_agent_id,
    });

    const migratedTelegram = db.getRegisteredGroup(telegramDmJid)!;
    expect(migratedTelegram.target_main_jid).toBeUndefined();
    expect(migratedTelegram.target_agent_id).toBeTruthy();
    expect(migratedTelegram.target_agent_id).not.toBe(
      migratedQq.target_agent_id,
    );
    expect(db.getAgent(migratedTelegram.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );

    const migratedWechat = db.getRegisteredGroup(wechatDmJid)!;
    expect(migratedWechat.target_main_jid).toBeUndefined();
    expect(migratedWechat.target_agent_id).toBeTruthy();
    expect(db.getAgent(migratedWechat.target_agent_id!)?.last_im_jid).toBe(
      wechatDmJid,
    );

    const migratedWecomLeftover = db.getRegisteredGroup(wecomLeftoverJid)!;
    expect(migratedWecomLeftover.target_main_jid).toBeUndefined();
    expect(migratedWecomLeftover.target_agent_id).toBeTruthy();

    expect(db.getSessionChannelOwner('legacy-shared-ws')).toBeUndefined();

    expect(db.getRegisteredGroup(qqGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(qqGroupJid)?.target_agent_id).toBeUndefined();
    expect(db.getChannelMount(qqGroupJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: null,
    });
    expect(db.getRegisteredGroup(telegramGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });

    expect(db.getRegisteredGroup(wecomMigratedJid)).toMatchObject({
      target_agent_id: 'wecom-v72-session',
    });
    expect(db.getRegisteredGroup(wecomMigratedJid)?.target_main_jid).toBe(
      undefined,
    );

    expect(db.getRegisteredGroup(manualDmJid)).toMatchObject({
      target_agent_id: 'manual-session',
    });
    expect(db.getRegisteredGroup(missingWsDmJid)).toMatchObject({
      target_main_jid: 'web:deleted-workspace',
    });
    expect(db.getRegisteredGroup(feishuUnknownJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(malformedTelegramJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });

    db.closeDatabase();
    const stamped = new Database(databasePath);
    stamped
      .prepare(
        "UPDATE router_state SET value = '72' WHERE key = 'schema_version'",
      )
      .run();
    stamped.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getRegisteredGroup(qqDmJid)?.target_agent_id).toBe(
      migratedQq.target_agent_id,
    );
    expect(db.getRegisteredGroup(wecomMigratedJid)?.target_agent_id).toBe(
      'wecom-v72-session',
    );
    expect(db.getRegisteredGroup(qqGroupJid)?.target_main_jid).toBe(
      workspaceJid,
    );
    expect(db.getRegisteredGroup(feishuUnknownJid)?.target_main_jid).toBe(
      workspaceJid,
    );
  });
});
