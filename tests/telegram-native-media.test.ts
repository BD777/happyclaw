import net from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const inbound = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
  storeMessageDirect: vi.fn(),
  notifyNewImMessage: vi.fn(),
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn(async () => ({ id: 1, username: 'media_bot' })),
      getFile: vi.fn(async () => ({})),
      setMessageReaction: vi.fn(async () => {}),
    };
    on(filter: string, fn: (ctx: unknown) => Promise<void>) {
      inbound.handlers.set(filter, fn);
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        inbound.stop = resolve;
      });
    }
    stop() {
      inbound.stop?.();
      inbound.stop = null;
    }
  },
  InputFile: class {},
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: inbound.storeMessageDirect,
  updateChatName: vi.fn(),
}));

vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: inbound.notifyNewImMessage,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createTelegramConnection,
  downloadTelegramHttpsBuffer,
  handleTelegramNativeMediaUpdate,
  telegramNativeFileFromMessage,
} from '../src/telegram.js';

describe('telegramNativeFileFromMessage', () => {
  test('picks video, voice, audio, and animation', () => {
    expect(
      telegramNativeFileFromMessage({
        video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
      }),
    ).toEqual({
      fileId: 'v1',
      fileName: 'clip.mp4',
      fileSize: 12,
      kind: 'video',
    });
    expect(
      telegramNativeFileFromMessage({
        voice: { file_id: 'vo1', file_size: 3 },
      }),
    ).toEqual({
      fileId: 'vo1',
      fileName: 'voice.ogg',
      fileSize: 3,
      kind: 'voice',
    });
    expect(
      telegramNativeFileFromMessage({
        audio: { file_id: 'a1', file_name: 'song.mp3', file_size: 8 },
      }),
    ).toEqual({
      fileId: 'a1',
      fileName: 'song.mp3',
      fileSize: 8,
      kind: 'audio',
    });
    expect(
      telegramNativeFileFromMessage({
        animation: { file_id: 'g1', file_size: 4 },
      }),
    ).toEqual({
      fileId: 'g1',
      fileName: 'animation.mp4',
      fileSize: 4,
      kind: 'animation',
    });
  });

  test('ignores empty messages', () => {
    expect(telegramNativeFileFromMessage({})).toBeNull();
  });
});

describe('handleTelegramNativeMediaUpdate (message:video)', () => {
  test('authorized video stores and notifies', async () => {
    const storeMessageDirect = vi.fn();
    const notifyNewImMessage = vi.fn();
    const onMessagePersisted = vi.fn();
    const result = await handleTelegramNativeMediaUpdate(
      {
        message: {
          message_id: 7,
          date: 1_777_000_000,
          video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
        },
        chat: { id: 99, title: 'Ada' },
        from: { id: 9, first_name: 'Ada' },
      },
      {
        isChatAuthorized: () => true,
        storeMessageDirect,
        notifyNewImMessage,
        onMessagePersisted,
        downloadRelPath: async () => 'telegram/clip.mp4',
      },
    );
    expect(result).toBe('stored');
    expect(storeMessageDirect).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[文件: telegram/clip.mp4]',
    );
    expect(notifyNewImMessage).toHaveBeenCalledTimes(1);
    expect(onMessagePersisted).toHaveBeenCalledTimes(1);
  });

  test('unauthorized video does not persist', async () => {
    const storeMessageDirect = vi.fn();
    const notifyNewImMessage = vi.fn();
    const result = await handleTelegramNativeMediaUpdate(
      {
        message: {
          message_id: 8,
          date: 1_777_000_000,
          video: { file_id: 'v2', file_name: 'clip.mp4' },
        },
        chat: { id: 99 },
      },
      {
        isChatAuthorized: () => false,
        storeMessageDirect,
        notifyNewImMessage,
      },
    );
    expect(result).toBe('unauthorized');
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(notifyNewImMessage).not.toHaveBeenCalled();
  });
});

describe('native media download timeout', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(closers.splice(0).map((close) => close()));
  }, 3000);

  test('times out against a blackhole peer', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    closers.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('no port');
    }
    const started = Date.now();
    await expect(
      downloadTelegramHttpsBuffer(`http://127.0.0.1:${addr.port}/file`, {
        timeoutMs: 250,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('Telegram native media inbound listeners', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/telegram.ts'),
    'utf8',
  );

  test('registers video/voice/audio/animation handlers that persist', () => {
    for (const kind of ['video', 'voice', 'audio', 'animation']) {
      expect(source).toContain(`bot.on('message:${kind}'`);
    }
    expect(source).toContain('handleNativeTelegramMedia');
    expect(source).toContain('handleTelegramNativeMediaUpdate');
    expect(source).toContain('const tgMessage = ctx.message');
    expect(source).not.toContain('const message = message');
    expect(source).toContain('downloadTelegramHttpsBuffer');
    expect(source).not.toContain("from './im-media-download.js'");
  });

  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    inbound.handlers.clear();
    inbound.storeMessageDirect.mockReset();
    inbound.notifyNewImMessage.mockReset();
    inbound.stop = null;
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  }, 8000);

  async function connectAuthorized(authorized: boolean) {
    connection = createTelegramConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => authorized,
    });
    expect(ok).toBe(true);
    return connection;
  }

  function videoCtx(messageId: number) {
    return {
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
      },
      chat: { id: 42, title: 'Ada' },
      from: { id: 9, first_name: 'Ada' },
      react: async () => {},
    };
  }

  test('connect() registers runtime bot.on listeners and video persist+notify', async () => {
    await connectAuthorized(true);
    for (const kind of ['video', 'voice', 'audio', 'animation']) {
      expect(typeof inbound.handlers.get(`message:${kind}`)).toBe('function');
    }
    const handler = inbound.handlers.get('message:video');
    expect(handler).toBeTypeOf('function');
    await handler!(videoCtx(101));
    expect(inbound.storeMessageDirect).toHaveBeenCalled();
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toMatch(/\[文件/);
    expect(inbound.notifyNewImMessage).toHaveBeenCalled();
  });

  test('inbound video listener skips unauthorized chats', async () => {
    await connectAuthorized(false);
    const handler = inbound.handlers.get('message:video');
    expect(handler).toBeTypeOf('function');
    await handler!(videoCtx(202));
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
    expect(inbound.notifyNewImMessage).not.toHaveBeenCalled();
  });
});
