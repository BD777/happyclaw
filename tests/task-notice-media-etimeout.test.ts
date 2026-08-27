import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-notice-media-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const workspaceFolder = 'notice-ws';
const workspaceRoot = path.join(groupsDir, workspaceFolder);
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { retryTaskNotification, sendTaskFileWithRetry, sendTaskImageWithRetry } =
  await import('../src/unscoped-task-media-outbox.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-primary',
  sourceJid: 'feishu:bot-primary:chat-1#root:root-1#thread:thread-1',
  chatId: 'chat-1',
  rootId: 'root-1',
  threadId: 'thread-1',
};

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const imageRel = 'notice.png';
const fileRel = 'notice.bin';
const imageAbs = path.join(workspaceRoot, imageRel);
const fileAbs = path.join(workspaceRoot, fileRel);
fs.writeFileSync(imageAbs, PNG_1X1);
fs.writeFileSync(fileAbs, Buffer.from('task-notice-file'));

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function etimedoutAfterAccept(): NodeJS.ErrnoException {
  const error = new Error(
    'ETIMEDOUT after provider accepted the task notice',
  ) as NodeJS.ErrnoException;
  error.code = 'ETIMEDOUT';
  return error;
}

function isRealpathInside(target: string, roots: string | string[]): boolean {
  const rootList = Array.isArray(roots) ? roots : [roots];
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return false;
  }
  return rootList.some((candidate) => {
    try {
      const realRoot = fs.realpathSync(candidate);
      return (
        realTarget === realRoot ||
        realTarget.startsWith(`${realRoot}${path.sep}`)
      );
    } catch {
      return false;
    }
  });
}

function makeRoute(chatId: string) {
  return {
    provider: 'feishu',
    accountId: 'bot-primary',
    sourceJid: `feishu:bot-primary:${chatId}#root:root-1#thread:thread-1`,
    chatId,
    rootId: 'root-1',
    threadId: 'thread-1',
  };
}

function mediaDeps(
  sendImage: () => Promise<void>,
  sendFile: () => Promise<void>,
  activeRoute = route,
) {
  return {
    isChannelAvailable: () => true,
    resolveRoute: () => activeRoute,
    sendImage,
    sendFile,
    groupsDir,
    isRealpathInside,
  };
}

describe('unscoped task notice media without outbox', () => {
  test('retryTaskNotification image ETIMEDOUT-after-accept stays 1 copy across scheduler retry', async () => {
    let sends = 0;
    const sendImage = async () => {
      sends += 1;
      if (sends === 1) throw etimedoutAfterAccept();
    };
    const sendFile = async () => {
      throw new Error('sendFile must not run for image notices');
    };
    const deps = mediaDeps(sendImage, sendFile);
    const payload = {
      kind: 'im_image' as const,
      targetJid: route.sourceJid,
      workspaceFolder,
      filePath: imageRel,
      mimeType: 'image/png',
      fileName: 'notice.png',
    };
    const first = await retryTaskNotification(payload, deps);
    const second = await retryTaskNotification(payload, deps);
    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(sends).toBe(1);
  });

  test('retryTaskNotification file ETIMEDOUT-after-accept stays 1 copy across scheduler retry', async () => {
    let sends = 0;
    const sendFile = async () => {
      sends += 1;
      if (sends === 1) throw etimedoutAfterAccept();
    };
    const sendImage = async () => {
      throw new Error('sendImage must not run for file notices');
    };
    const deps = mediaDeps(sendImage, sendFile);
    const payload = {
      kind: 'im_file' as const,
      targetJid: route.sourceJid,
      workspaceFolder,
      filePath: fileRel,
      fileName: 'notice.bin',
    };
    const first = await retryTaskNotification(payload, deps);
    const second = await retryTaskNotification(payload, deps);
    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(sends).toBe(1);
  });

  test('unscoped sendTaskImageWithRetry ETIMEDOUT-after-accept stays 1 copy', async () => {
    let sends = 0;
    const helperRoute = makeRoute('chat-image-helper');
    const helperPng = Buffer.concat([PNG_1X1, Buffer.from([0x00])]);
    const sendImage = async () => {
      sends += 1;
      if (sends === 1) throw etimedoutAfterAccept();
    };
    const sendFile = async () => {
      throw new Error('sendFile must not run for image notices');
    };
    const deps = mediaDeps(sendImage, sendFile, helperRoute);
    const first = await sendTaskImageWithRetry(
      helperRoute.sourceJid,
      helperPng,
      'image/png',
      undefined,
      'helper.png',
      undefined,
      deps,
    );
    const second = await sendTaskImageWithRetry(
      helperRoute.sourceJid,
      helperPng,
      'image/png',
      undefined,
      'helper.png',
      undefined,
      deps,
    );
    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(sends).toBe(1);
  });

  test('unscoped sendTaskFileWithRetry ETIMEDOUT-after-accept stays 1 copy', async () => {
    let sends = 0;
    const helperRoute = makeRoute('chat-file-helper');
    const helperAbs = path.join(workspaceRoot, 'helper.bin');
    fs.writeFileSync(helperAbs, Buffer.from('task-notice-file-helper'));
    const sendFile = async () => {
      sends += 1;
      if (sends === 1) throw etimedoutAfterAccept();
    };
    const sendImage = async () => {
      throw new Error('sendImage must not run for file notices');
    };
    const deps = mediaDeps(sendImage, sendFile, helperRoute);
    const first = await sendTaskFileWithRetry(
      helperRoute.sourceJid,
      helperAbs,
      'helper.bin',
      undefined,
      deps,
    );
    const second = await sendTaskFileWithRetry(
      helperRoute.sourceJid,
      helperAbs,
      'helper.bin',
      undefined,
      deps,
    );
    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(sends).toBe(1);
  });

  test('route=null ECONNREFUSED sends once via sendTaskImageWithRetry', async () => {
    let sends = 0;
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const ok = await sendTaskImageWithRetry(
      'whatsapp:unrouted',
      PNG_1X1,
      'image/png',
      undefined,
      'no-route.png',
      undefined,
      {
        isChannelAvailable: () => true,
        resolveRoute: () => null,
        sendImage: async () => {
          sends += 1;
          throw refused;
        },
        sendFile: async () => {
          throw new Error('sendFile must not run for image notices');
        },
      },
    );
    expect(ok).toBe(false);
    expect(sends).toBe(1);
  });

  test('isRealpathInside rejects a path that escapes the workspace', async () => {
    const escapeRel = path.join('..', 'outside.png');
    fs.writeFileSync(path.join(groupsDir, 'outside.png'), PNG_1X1);
    await expect(
      retryTaskNotification(
        {
          kind: 'im_image',
          targetJid: route.sourceJid,
          workspaceFolder,
          filePath: escapeRel,
          mimeType: 'image/png',
          fileName: 'outside.png',
        },
        mediaDeps(
          async () => {
            throw new Error('must not send escaped image');
          },
          async () => {
            throw new Error('must not send escaped file');
          },
        ),
      ),
    ).rejects.toThrow(/left its workspace|unavailable/);
  });
});
