import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'leftover-direct-mount-repair-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
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
const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');
const {
  diagnoseLeftoverClassifiableDirectWorkspaceMounts,
  repairLeftoverClassifiableDirectWorkspaceMounts,
} = await import('../src/leftover-direct-mount-repair.js');

const now = '2026-08-18T00:00:00.000Z';
const oldIsolationAt = '2026-08-18T00:00:00.000Z';
const repairAt = '2026-08-20T04:00:00.000Z';

const workspaceJid = 'web:leftover-repair-ws';
const folder = 'leftover-repair-ws';
const qqDmJid = 'qq:c2c:alice#account:bot-a';
const qqGroupJid = 'qq:group:sales#account:bot-a';
const discordDmJid = 'discord:dm:alice#account:bot-a';
const discordGroupJid = 'discord:guild-channel-1#account:bot-a';
const waLidJid = 'whatsapp:123456789012345@lid#account:bot-a';
const waHostedJid = 'whatsapp:15551230000@hosted#account:bot-a';
const waHostedLidJid = 'whatsapp:15551230001@hosted.lid#account:bot-a';
const waPnJid = 'whatsapp:15551230002@s.whatsapp.net#account:bot-a';
const waGroupJid = 'whatsapp:120363000000000000@g.us#account:bot-a';
const feishuUnknownJid = 'feishu:oc_opaque#account:bot-a';
const leftoverDirectJids = [
  qqDmJid,
  discordDmJid,
  waLidJid,
  waHostedJid,
  waHostedLidJid,
  waPnJid,
] as const;

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLeftoverDirectState(): void {
  db.setRegisteredGroup(workspaceJid, {
    name: 'Leftover repair workspace',
    folder,
    added_at: now,
    created_by: 'owner-a',
  });
  for (const [jid, name] of [
    [qqDmJid, 'QQ leftover DM'],
    [discordDmJid, 'Discord leftover DM'],
    [waLidJid, 'WhatsApp LID leftover DM'],
    [waHostedJid, 'WhatsApp hosted leftover DM'],
    [waHostedLidJid, 'WhatsApp hosted.lid leftover DM'],
    [waPnJid, 'WhatsApp PN leftover DM'],
  ] as const) {
    db.setRegisteredGroup(jid, {
      name,
      folder: `${folder}-direct`,
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
  }
  for (const [jid, name] of [
    [qqGroupJid, 'QQ group'],
    [discordGroupJid, 'Discord guild'],
    [waGroupJid, 'WhatsApp group'],
    [feishuUnknownJid, 'Feishu opaque chat'],
  ] as const) {
    db.setRegisteredGroup(jid, {
      name,
      folder: `${folder}-group`,
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
  }

  db.setSession(folder, 'contaminated-main-session');
  db.setSessionChannelOwnerOnce(folder, null, waLidJid);
  db.setRouterState(
    `conversation_history_isolation:${workspaceJid}`,
    oldIsolationAt,
  );
  db.ensureChatExists(workspaceJid);
  db.storeMessageDirect(
    'pre-marker-private',
    workspaceJid,
    waLidJid,
    'Private Alice',
    'old private value fenced by the first isolation marker',
    now,
    false,
    { sourceJid: waLidJid },
  );
  db.storeMessageDirect(
    'post-marker-private-leak',
    workspaceJid,
    waLidJid,
    'Private Alice',
    'post-marker LID leak that must not stay recoverable',
    '2026-08-19T00:00:00.000Z',
    false,
    { sourceJid: waLidJid },
  );
  db.storeMessageDirect(
    'post-marker-group',
    workspaceJid,
    waGroupJid,
    'Group Bob',
    'group context that arrived after the first isolation marker',
    '2026-08-19T00:00:01.000Z',
    false,
    { sourceJid: waGroupJid },
  );
}

describe.sequential('leftover classifiable DM diagnostic/repair tool', () => {
  test('dry-run reports leftover JID DMs and leaves contaminated recovery state intact', () => {
    db.initDatabase();
    seedLeftoverDirectState();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const diagnosis = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
    expect(diagnosis.schemaVersion).toBe(String(db.CURRENT_SCHEMA_VERSION));
    expect(diagnosis.leftovers.map((item) => item.channelJid).sort()).toEqual(
      [...leftoverDirectJids].sort(),
    );
    expect(
      diagnosis.leftovers.find((item) => item.channelJid === waLidJid),
    ).toMatchObject({
      workspaceJid,
      workspaceFolder: folder,
      mainOwnerIsThisChat: true,
      mainSessionId: 'contaminated-main-session',
      existingIsolationMarker: oldIsolationAt,
      recoverableInboundFromThisChat: 2,
    });
    expect(diagnosis.affectedWorkspaces).toEqual([
      expect.objectContaining({
        workspaceJid,
        leftoverCount: leftoverDirectJids.length,
        existingIsolationMarker: oldIsolationAt,
        mainSessionId: 'contaminated-main-session',
        mainOwnerJid: waLidJid,
        recoverableInboundFromLeftovers: 2,
      }),
    ]);

    const dryRun = repairLeftoverClassifiableDirectWorkspaceMounts();
    expect(dryRun.applied).toBe(false);
    expect(dryRun.remounted).toBe(0);
    expect(dryRun.isolationGenerationsReset).toBe(0);
    expect(db.getRegisteredGroup(waLidJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getSession(folder)).toBe('contaminated-main-session');
    expect(db.getSessionChannelOwner(folder)).toBe(waLidJid);
    expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
      oldIsolationAt,
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const leaked = buildRecentConversationHistoryContext(
      workspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(leaked?.context).toContain(
      'post-marker LID leak that must not stay recoverable',
    );
    expect(leaked?.context).toContain(
      'group context that arrived after the first isolation marker',
    );
  });

  test('apply remounts leftovers and resets isolation generation so post-marker leaks are not recoverable', () => {
    const repaired = repairLeftoverClassifiableDirectWorkspaceMounts({
      apply: true,
      isolationStartedAt: repairAt,
    });
    expect(repaired.applied).toBe(true);
    expect(repaired.remounted).toBe(leftoverDirectJids.length);
    expect(repaired.isolationGenerationsReset).toBe(1);
    expect(repaired.isolationMarkers[workspaceJid]).toBe(repairAt);
    expect(repaired.schemaVersion).toBe(String(db.CURRENT_SCHEMA_VERSION));
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    for (const jid of leftoverDirectJids) {
      const group = db.getRegisteredGroup(jid)!;
      expect(group.target_main_jid).toBeUndefined();
      expect(group.target_agent_id).toBeTruthy();
      expect(db.getAgent(group.target_agent_id!)?.source_kind).toBe(
        'channel_direct',
      );
      expect(db.getChannelMount(jid)).toMatchObject({
        workspace_jid: workspaceJid,
        session_id: group.target_agent_id,
      });
    }

    expect(db.getRegisteredGroup(qqGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(discordGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(waGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(feishuUnknownJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });

    expect(db.getSession(folder)).toBeUndefined();
    expect(db.getWorkspaceRuntimeSession(folder)).toBeUndefined();
    expect(db.getSessionChannelOwner(folder)).toBeUndefined();
    expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
      repairAt,
    );
    expect(repairAt).not.toBe(oldIsolationAt);

    const history = buildRecentConversationHistoryContext(
      workspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(history).toBeNull();
    expect(
      db
        .getConversationHistoryMessagesPage(workspaceJid, new Set(), 30)
        .map((message) => message.id),
    ).toEqual([]);

    db.setSession(folder, 'clean-main-after-repair');
    expect(db.setSessionChannelOwnerOnce(folder, null, waGroupJid)).toBe(
      waGroupJid,
    );
    expect(db.setSessionChannelOwnerOnce(folder, null, waLidJid)).toBe(
      waGroupJid,
    );
    db.storeMessageDirect(
      'safe-after-repair',
      workspaceJid,
      waGroupJid,
      'Group Bob',
      'safe group context after the new isolation generation',
      '2026-08-20T04:00:01.000Z',
      false,
      { sourceJid: waGroupJid },
    );
    const after = buildRecentConversationHistoryContext(
      workspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(after?.messageIds).toEqual(['safe-after-repair']);
    expect(after?.context).toContain(
      'safe group context after the new isolation generation',
    );
    expect(after?.context).not.toContain(
      'post-marker LID leak that must not stay recoverable',
    );
    expect(after?.context).not.toContain(
      'old private value fenced by the first isolation marker',
    );

    const noop = repairLeftoverClassifiableDirectWorkspaceMounts({
      apply: true,
    });
    expect(noop.applied).toBe(false);
    expect(noop.remounted).toBe(0);
    expect(db.getSession(folder)).toBe('clean-main-after-repair');
    expect(db.getSessionChannelOwner(folder)).toBe(waGroupJid);
    expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
      repairAt,
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
  });

  test('schema v73 remount-only leaves post-marker leaks recoverable, which is why this is not a migration', () => {
    const siblingWorkspaceJid = 'web:v73-remount-only';
    const siblingFolder = 'v73-remount-only';
    const leftoverJid = 'whatsapp:15551238888@lid#account:bot-b';
    const groupJid = 'whatsapp:120363111111111111@g.us#account:bot-b';
    db.setRegisteredGroup(siblingWorkspaceJid, {
      name: 'v73 remount-only workspace',
      folder: siblingFolder,
      added_at: now,
      created_by: 'owner-b',
    });
    db.setRegisteredGroup(leftoverJid, {
      name: 'LID leftover after old marker',
      folder: `${siblingFolder}-direct`,
      added_at: now,
      created_by: 'owner-b',
      channel_account_id: 'bot-b',
      target_main_jid: siblingWorkspaceJid,
    });
    db.setRegisteredGroup(groupJid, {
      name: 'WhatsApp group',
      folder: `${siblingFolder}-group`,
      added_at: now,
      created_by: 'owner-b',
      channel_account_id: 'bot-b',
      target_main_jid: siblingWorkspaceJid,
    });
    db.setSession(siblingFolder, 'still-contaminated-main');
    db.setSessionChannelOwnerOnce(siblingFolder, null, leftoverJid);
    db.setRouterState(
      `conversation_history_isolation:${siblingWorkspaceJid}`,
      oldIsolationAt,
    );
    db.ensureChatExists(siblingWorkspaceJid);
    db.storeMessageDirect(
      'v73-post-marker-leak',
      siblingWorkspaceJid,
      leftoverJid,
      'Private Alice',
      'v73 remount-only must not be treated as a successful privacy repair',
      '2026-08-19T12:00:00.000Z',
      false,
      { sourceJid: leftoverJid },
    );

    expect(
      db.migrateClassifiableDirectWorkspaceMountsToSessions(),
    ).toBeGreaterThanOrEqual(1);
    expect(db.getRegisteredGroup(leftoverJid)?.target_main_jid).toBeUndefined();
    expect(db.getSession(siblingFolder)).toBe('still-contaminated-main');
    expect(db.getConversationHistoryIsolationMarker(siblingWorkspaceJid)).toBe(
      oldIsolationAt,
    );
    const afterV73 = buildRecentConversationHistoryContext(
      siblingWorkspaceJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(afterV73?.context).toContain(
      'v73 remount-only must not be treated as a successful privacy repair',
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
  });
});
