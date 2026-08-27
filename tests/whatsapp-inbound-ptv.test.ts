import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

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
  vi.fn(async () => Buffer.from('video-bytes')),
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
vi.mock('../src/im-downloader.js', () => ({
  saveDownloadedFile: vi.fn(async (_folder, _ch, fileName) => `ws/${fileName}`),
  FileTooLargeError: class FileTooLargeError extends Error {},
}));
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

const { createWhatsAppConnection } = await import('../src/whatsapp.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-inbound-ptv-'));

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
    resolveGroupFolder: () => '/tmp/wa-ws',
    resolveEffectiveChatJid: (jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    }),
  });
  const socket = harness.sockets.at(-1)!;
  return { connection, socket };
}

describe('WhatsApp inbound ptvMessage video-note', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    downloadMediaMessage.mockResolvedValue(Buffer.from('video-bytes'));
  });

  test('authorized ptvMessage persists, downloads, and notifies', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'ptv-1', {
          ptvMessage: { mimetype: 'video/mp4', caption: 'note' },
        }),
      ],
    });
    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(db.storeMessageDirect).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/视频/);
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });

  test('unauthorized ptvMessage does not persist', async () => {
    const { socket } = await connect(false);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'ptv-deny', {
          ptvMessage: { mimetype: 'video/mp4' },
        }),
      ],
    });
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    expect(notify.notifyNewImMessage).not.toHaveBeenCalled();
  });

  test('regular videoMessage MP4 still persists', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'vid-1', {
          videoMessage: { mimetype: 'video/mp4', caption: 'clip' },
        }),
      ],
    });
    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(db.storeMessageDirect).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/视频/);
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });
});
