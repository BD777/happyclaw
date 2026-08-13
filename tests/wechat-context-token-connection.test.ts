import type { Dispatcher } from 'undici';
import { describe, expect, test, vi } from 'vitest';

import type {
  WeChatContextTokenClaimInput,
  WeChatContextTokenRecord,
  WeChatContextTokenStore,
} from '../src/wechat-context-token.js';

const dbCalls = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  ...dbCalls,
  isDatabaseInitialized: () => false,
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));
vi.mock('../src/web.js', () => ({ broadcastNewMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWeChatConnection } = await import('../src/wechat.js');

class SharedStore implements WeChatContextTokenStore {
  record: WeChatContextTokenRecord | undefined;

  list(accountId: string): WeChatContextTokenRecord[] {
    return this.record?.accountId === accountId ? [{ ...this.record }] : [];
  }

  upsert(input: {
    accountId: string;
    userId: string;
    token: string;
    refreshedAtMs: number;
  }): WeChatContextTokenRecord {
    this.record = { ...input, sendCount: 0, lastSentAtMs: null };
    return { ...this.record };
  }

  claim(
    input: WeChatContextTokenClaimInput,
  ):
    | { status: 'claimed'; record: WeChatContextTokenRecord }
    | { status: 'missing' | 'changed' | 'expired' | 'quota_exhausted' } {
    const record = this.record;
    if (!record) return { status: 'missing' };
    if (
      record.token !== input.expectedToken ||
      record.refreshedAtMs !== input.expectedRefreshedAtMs
    ) {
      return { status: 'changed' };
    }
    const claimed = {
      ...record,
      sendCount: record.sendCount + input.claimCount,
      lastSentAtMs: input.nowMs,
    };
    this.record = claimed;
    return { status: 'claimed', record: { ...claimed } };
  }

  delete(input: {
    accountId: string;
    userId: string;
    expectedToken?: string;
    expectedRefreshedAtMs?: number;
  }): boolean {
    if (
      !this.record ||
      this.record.accountId !== input.accountId ||
      this.record.userId !== input.userId ||
      (input.expectedToken !== undefined &&
        (this.record.token !== input.expectedToken ||
          this.record.refreshedAtMs !== input.expectedRefreshedAtMs))
    ) {
      return false;
    }
    this.record = undefined;
    return true;
  }
}

function waitUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

describe('WeChat connection durable context_token integration', () => {
  test('persists inbound token, restores after restart, and invalidates ret=-2 without tokenless retry', async () => {
    const store = new SharedStore();
    const dispatcher = {
      close: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    let firstPoll = true;
    const firstFetch = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal | null }) => {
        if (firstPoll) {
          firstPoll = false;
          return Response.json({
            get_updates_buf: 'cursor-1',
            msgs: [
              {
                message_id: 1,
                from_user_id: 'peer',
                message_type: 1,
                create_time_ms: Date.now(),
                context_token: 'durable-secret',
                item_list: [{ type: 1, text_item: { text: 'hello' } }],
              },
            ],
          });
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const first = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: firstFetch as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await first.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    });
    await vi.waitFor(() => expect(store.record?.token).toBe('durable-secret'));
    await first.disconnect();

    let sendAttempts = 0;
    const secondFetch = vi.fn(
      async (url: string, init?: { signal?: AbortSignal | null }) => {
        if (url.includes('sendmessage')) {
          sendAttempts += 1;
          const body = JSON.parse(String((init as { body?: unknown })?.body));
          expect(body.msg.context_token).toBe('durable-secret');
          return Response.json(
            sendAttempts === 1 ? { ret: 0 } : { ret: -2, errmsg: '' },
          );
        }
        return waitUntilAborted(init?.signal);
      },
    );
    const restarted = createWeChatConnection(
      {
        botToken: 'bot-token',
        ilinkBotId: 'bot-id',
        logContext: { accountId: 'account' },
      },
      {
        fetch: secondFetch as typeof fetch,
        createDispatcher: () => dispatcher,
        contextTokenStore: store,
      },
    );
    await restarted.connect({ onNewChat: vi.fn() });
    await expect(restarted.sendMessage('peer', 'after restart')).resolves.toBe(
      undefined,
    );
    await expect(restarted.sendMessage('peer', 'stale now')).rejects.toThrow(
      'ret=-2',
    );
    expect(store.record).toBeUndefined();
    await expect(
      restarted.sendMessage('peer', 'must not fall back'),
    ).rejects.toThrow('请让该用户先向机器人发送一条新消息');
    expect(sendAttempts).toBe(2);
    await restarted.disconnect();
  });
});
