import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
      getMe: vi.fn(async () => ({ id: 1, username: 'YourBot' })),
      getFile: vi.fn(async () => ({})),
      setMessageReaction: vi.fn(async () => {}),
      getChat: vi.fn(async () => ({ is_forum: false })),
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

import { createTelegramConnection } from '../src/telegram.js';

describe('Telegram unpaired /pair@BotUsername', () => {
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

  async function connectUnpaired(onPairAttempt: ReturnType<typeof vi.fn>) {
    connection = createTelegramConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => false,
      onPairAttempt,
    });
    expect(ok).toBe(true);
    const handler = inbound.handlers.get('message:text');
    expect(handler).toBeTypeOf('function');
    return handler!;
  }

  function textCtx(messageId: number, text: string) {
    return {
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        text,
      },
      chat: { id: 42, type: 'private', title: 'Ada' },
      from: { id: 9, first_name: 'Ada' },
      reply: vi.fn(async () => undefined),
    };
  }

  test('unpaired /pair@YourBot ABC123 reaches onPairAttempt and does not persist', async () => {
    const onPairAttempt = vi.fn(async () => true);
    const handler = await connectUnpaired(onPairAttempt);
    const ctx = textCtx(101, '/pair@YourBot ABC123');
    await handler(ctx);
    expect(onPairAttempt).toHaveBeenCalledWith('telegram:42', 'Ada', 'ABC123');
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  test('plain unpaired /pair ABC123 still pairs', async () => {
    const onPairAttempt = vi.fn(async () => true);
    const handler = await connectUnpaired(onPairAttempt);
    await handler(textCtx(202, '/pair ABC123'));
    expect(onPairAttempt).toHaveBeenCalledWith('telegram:42', 'Ada', 'ABC123');
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('unauthorized non-pair text still deny-hints and does not pair', async () => {
    const onPairAttempt = vi.fn(async () => true);
    const handler = await connectUnpaired(onPairAttempt);
    const ctx = textCtx(303, 'hello');
    await handler(ctx);
    expect(onPairAttempt).not.toHaveBeenCalled();
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
    expect(String(ctx.reply.mock.calls[0][0])).toMatch(/not yet paired/i);
  });
});
