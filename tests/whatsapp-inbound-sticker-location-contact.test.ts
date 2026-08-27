import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { proto } from 'baileys';

const harness = vi.hoisted(() => {
  type Listener = (value: any) => unknown;
  function createSocket() {
    const listeners = new Map<string, Listener[]>();
    return {
      listeners,
      ev: {
        on: vi.fn((event: string, listener: Listener) => {
          const entries = listeners.get(event) ?? [];
          entries.push(listener);
          listeners.set(event, entries);
        }),
      },
      ws: { on: vi.fn(), isConnecting: false },
      user: { id: '19990001111:7@s.whatsapp.net', name: 'Test bot' },
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
      groupMetadata: vi.fn(async () => ({ subject: 'Test group' })),
      end: vi.fn(),
      logout: vi.fn(async () => undefined),
      updateMediaMessage: vi.fn(),
      async emit(event: string, value: unknown) {
        await Promise.all(
          (listeners.get(event) ?? []).map((listener) => listener(value)),
        );
      },
    };
  }
  return { sockets: [] as ReturnType<typeof createSocket>[], createSocket };
});

const downloadMediaMessage = vi.hoisted(() =>
  vi.fn(async () => Buffer.from('sticker-bytes')),
);

vi.mock('baileys', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    downloadMediaMessage,
    makeWASocket: vi.fn(() => {
      const socket = harness.createSocket();
      harness.sockets.push(socket);
      return socket;
    }),
    useMultiFileAuthState: vi.fn(async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(async () => undefined),
    })),
    fetchLatestBaileysVersion: vi.fn(async () => ({
      version: [2, 3000, 1],
      isLatest: true,
    })),
  };
});

const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
  getRegisteredGroup: vi.fn(),
  getDefaultChannelAccount: vi.fn(),
  getLegacyChannelAccount: vi.fn(),
  getChannelAccount: vi.fn(),
  getUserById: vi.fn(),
  isDatabaseInitialized: vi.fn(() => false),
}));
vi.mock('../src/db.js', () => db);

const notify = vi.hoisted(() => ({ notifyNewImMessage: vi.fn() }));
vi.mock('../src/message-notifier.js', () => notify);
vi.mock('../src/web.js', () => ({ broadcastNewMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,test') },
}));
vi.mock('proxy-agent', () => ({
  ProxyAgent: class {
    destroy() {}
  },
}));

const { createWhatsAppConnection, detectMedia, extractMessageText } =
  await import('../src/whatsapp.js');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'whatsapp-inbound-sticker-'),
);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function upsertMessage(
  remoteJid: string,
  id: string,
  message: Record<string, unknown>,
) {
  return {
    key: { remoteJid, id, fromMe: false },
    message,
    pushName: 'Ada',
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

async function connect(authorized: boolean) {
  const connection = createWhatsAppConnection({
    accountId: authorized ? 'bot-ok' : 'bot-deny',
    authDir: path.join(root, authorized ? 'bot-ok' : 'bot-deny'),
  });
  await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => authorized,
  });
  const socket = harness.sockets.at(-1)!;
  return { connection, socket };
}

describe('WhatsApp inbound sticker / location / contact (live upsert)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    downloadMediaMessage.mockResolvedValue(Buffer.from('sticker-bytes'));
  });

  test('authorized stickerMessage persists and notifies via messages.upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'sticker-1', {
          stickerMessage: { mimetype: 'image/webp' },
        }),
      ],
    });
    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(db.storeMessageDirect).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/贴纸/);
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });

  test('authorized locationMessage persists as text via messages.upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'loc-1', {
          locationMessage: {
            degreesLatitude: 31.2,
            degreesLongitude: 121.5,
            name: '外滩',
            address: '上海市中山东一路',
          },
        }),
      ],
    });
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe(
      '[位置: 外滩 | 地址: 上海市中山东一路 | 坐标: 31.2, 121.5]',
    );
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });

  test('authorized contactMessage persists as text via messages.upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'contact-1', {
          contactMessage: {
            displayName: '张三',
            vcard:
              'BEGIN:VCARD\nVERSION:3.0\nFN:张三\nTEL;TYPE=CELL:+86 13800000000\nEMAIL:zhangsan@example.com\nORG:示例公司;研发部\nEND:VCARD',
          },
        }),
      ],
    });
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe(
      '[联系人: 张三]\n电话: +86 13800000000\n邮箱: zhangsan@example.com\n组织: 示例公司 / 研发部',
    );
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });

  test('unauthorized stickerMessage does not persist', async () => {
    const { socket } = await connect(false);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'sticker-deny', {
          stickerMessage: { mimetype: 'image/webp' },
        }),
      ],
    });
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    expect(notify.notifyNewImMessage).not.toHaveBeenCalled();
  });
});

describe('detectMedia / extractMessageText helpers', () => {
  test('stickerMessage is detected', () => {
    expect(
      detectMedia({
        stickerMessage: { mimetype: 'image/webp' },
      } as proto.IMessage),
    ).toMatchObject({ kind: 'sticker', label: '贴纸' });
  });

  test('location and contact extract as text', () => {
    expect(
      extractMessageText({
        locationMessage: {
          degreesLatitude: 31.2,
          degreesLongitude: 121.5,
          name: '外滩',
          address: '上海市中山东一路',
        },
      } as proto.IMessage),
    ).toBe('[位置: 外滩 | 地址: 上海市中山东一路 | 坐标: 31.2, 121.5]');
    expect(
      extractMessageText({
        contactMessage: {
          displayName: '张三',
          vcard:
            'BEGIN:VCARD\nN:Zhang;San;;;\nTEL:+8613800000000\nEMAIL:san@example.com\nORG:Acme;R&D\nEND:VCARD',
        },
      } as proto.IMessage),
    ).toBe(
      '[联系人: 张三]\n电话: +8613800000000\n邮箱: san@example.com\n组织: Acme / R&D',
    );
  });

  test('vCard parser ignores executable/unknown fields and unfolds safe values', () => {
    expect(
      extractMessageText({
        contactMessage: {
          vcard:
            'BEGIN:VCARD\r\nN:Doe;Jane;;;\r\nTEL;TYPE=CELL:+1-555-0100\r\nEMAIL:jane@exam\r\n ple.com\r\nURL:javascript:alert(1)\r\nEND:VCARD',
        },
      } as proto.IMessage),
    ).toBe('[联系人: Jane Doe]\n电话: +1-555-0100\n邮箱: jane@example.com');
  });
});
