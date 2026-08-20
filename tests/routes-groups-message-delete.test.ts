/**
 * Regression: DELETE /api/groups/:jid/messages/:messageId for runtime sessions.
 *
 * Runtime session messages are stored under the virtual chat JID
 * `{workspaceJid}#agent:{sessionId}`, and the Web client sends the message's
 * own chat_jid. The route used to resolve that raw JID through
 * getRegisteredGroup(), which never has a row for a virtual JID, so every
 * delete inside a runtime session returned 404 and the message stayed put.
 *
 * The route now splits the `#agent:` suffix off for the workspace lookup and
 * ACL check, validates the session belongs to that workspace, and deletes from
 * the virtual JID the row actually lives in.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-groups-msgdel-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const OWNER_ID = 'alice';
const OTHER_ID = 'mallory';

const JID = 'web:msgdel-workspace';
const FOLDER = 'msgdel-workspace';
const SESSION_ID = 'session-msgdel-1';
const VIRTUAL_JID = `${JID}#agent:${SESSION_ID}`;

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

function del(chatJid: string, messageId: string): Promise<Response> {
  return groupRoutes.request(
    `/${encodeURIComponent(chatJid)}/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' },
  );
}

function seedMessage(
  id: string,
  chatJid: string,
  sender: string,
  isFromMe = false,
): void {
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    id,
    chatJid,
    sender,
    sender,
    `content of ${id}`,
    new Date().toISOString(),
    isFromMe,
  );
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  db.setRegisteredGroup(JID, {
    name: 'Msg Delete Workspace',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  db.createAgent({
    id: SESSION_ID,
    group_folder: FOLDER,
    chat_jid: JID,
    name: 'ChatHistory-Session',
    prompt: '',
    status: 'completed',
    kind: 'conversation',
    created_by: OWNER_ID,
    created_at: new Date().toISOString(),
  } as any);
  asUser(OWNER_ID, 'member');
});

afterEach(() => {
  try {
    db.deleteAgent(SESSION_ID);
  } catch {
    /* ignore */
  }
  try {
    db.deleteRegisteredGroup(JID);
  } catch {
    /* ignore */
  }
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

describe('DELETE /:jid/messages/:messageId', () => {
  test('deletes a runtime session message addressed by its virtual JID', async () => {
    seedMessage('msg-runtime-1', VIRTUAL_JID, OWNER_ID);

    const res = await del(VIRTUAL_JID, 'msg-runtime-1');

    expect(res.status).toBe(200);
    expect(db.getMessage(VIRTUAL_JID, 'msg-runtime-1')).toBeNull();
  });

  test('still deletes a main session message addressed by the workspace JID', async () => {
    seedMessage('msg-main-1', JID, OWNER_ID);

    const res = await del(JID, 'msg-main-1');

    expect(res.status).toBe(200);
    expect(db.getMessage(JID, 'msg-main-1')).toBeNull();
  });

  test('a session id from another workspace cannot delete through this workspace', async () => {
    const foreignVirtualJid = `${JID}#agent:session-owned-elsewhere`;
    db.createAgent({
      id: 'session-owned-elsewhere',
      group_folder: 'other-folder',
      chat_jid: 'web:other-workspace',
      name: 'Foreign Session',
      prompt: '',
      status: 'completed',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
    } as any);
    seedMessage('msg-foreign-1', foreignVirtualJid, OWNER_ID);

    const res = await del(foreignVirtualJid, 'msg-foreign-1');

    expect(res.status).toBe(404);
    expect(db.getMessage(foreignVirtualJid, 'msg-foreign-1')).not.toBeNull();
    db.deleteAgent('session-owned-elsewhere');
  });

  test('an unknown session id is rejected', async () => {
    const unknownVirtualJid = `${JID}#agent:no-such-session`;
    seedMessage('msg-unknown-1', unknownVirtualJid, OWNER_ID);

    const res = await del(unknownVirtualJid, 'msg-unknown-1');

    expect(res.status).toBe(404);
    expect(db.getMessage(unknownVirtualJid, 'msg-unknown-1')).not.toBeNull();
  });

  test('a non-owner cannot delete a runtime session message', async () => {
    seedMessage('msg-runtime-2', VIRTUAL_JID, OWNER_ID);
    asUser(OTHER_ID, 'member');

    const res = await del(VIRTUAL_JID, 'msg-runtime-2');

    expect(res.status).toBe(404);
    expect(db.getMessage(VIRTUAL_JID, 'msg-runtime-2')).not.toBeNull();
  });

  test('the AI-message ownership rule still applies inside a runtime session', async () => {
    seedMessage('msg-runtime-ai', VIRTUAL_JID, 'happyclaw-agent', true);

    const res = await del(VIRTUAL_JID, 'msg-runtime-ai');

    expect(res.status).toBe(403);
    expect(db.getMessage(VIRTUAL_JID, 'msg-runtime-ai')).not.toBeNull();
  });
});
