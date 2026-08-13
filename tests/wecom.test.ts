import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkMock = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  class MockWSClient {
    static instances: MockWSClient[] = [];
    readonly listeners = new Map<string, Listener[]>();
    readonly options: Record<string, unknown>;
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => ({ errcode: 0 }));
    replyStream = vi.fn(async () => ({ errcode: 0 }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockWSClient.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }
  return { MockWSClient, req: 0 };
});

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: sdkMock.MockWSClient,
  generateReqId: (prefix: string) => `${prefix}-${++sdkMock.req}`,
}));

vi.mock('../src/db.js', () => ({ storeMessageDirect: vi.fn() }));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));
vi.mock('../src/web.js', () => ({ broadcastNewMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { storeMessageDirect } from '../src/db.js';
import { notifyNewImMessage } from '../src/message-notifier.js';
import { broadcastNewMessage } from '../src/web.js';
import { createWeComConnection, splitWeComMarkdown } from '../src/wecom.js';
import {
  truncateWeComUtf8,
  WECOM_MARKDOWN_MAX_BYTES,
} from '../src/wecom-streaming.js';

type MockClient = InstanceType<typeof sdkMock.MockWSClient>;

function frame(input: {
  reqId: string;
  msgId?: string;
  content?: string;
  userId?: string;
  chatId?: string;
  chattype?: 'single' | 'group';
  createTime?: number;
}) {
  const chattype = input.chattype ?? 'single';
  return {
    headers: { req_id: input.reqId },
    body: {
      msgid: input.msgId ?? input.reqId,
      aibotid: 'bot-1',
      chattype,
      chatid: chattype === 'group' ? (input.chatId ?? 'group-1') : undefined,
      from: { userid: input.userId ?? 'user-1' },
      create_time: input.createTime ?? Math.floor(Date.now() / 1000),
      msgtype: 'text',
      text: { content: input.content ?? 'hello' },
    },
  } as any;
}

async function connect(overrides: Record<string, unknown> = {}): Promise<{
  connection: ReturnType<typeof createWeComConnection>;
  client: MockClient;
  opts: Record<string, any>;
}> {
  const connection = createWeComConnection({
    botId: 'bot-1',
    secret: 'secret-1',
    channelAccountId: 'account-1',
    authTimeoutMs: 1000,
  });
  const opts = {
    onNewChat: vi.fn(),
    isChatAuthorized: vi.fn(() => true),
    resolveEffectiveChatJid: vi.fn((jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    })),
    ...overrides,
  };
  const pending = connection.connect(opts);
  const client = sdkMock.MockWSClient.instances.at(-1)!;
  client.emit('authenticated');
  await pending;
  return { connection, client, opts };
}

describe('WeCom connection security and delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.MockWSClient.instances.length = 0;
    sdkMock.req = 0;
  });

  test('connect waits for authentication and publishes lifecycle state', async () => {
    const states: string[] = [];
    const connection = createWeComConnection({
      botId: 'bot-1',
      secret: 'secret-1',
      authTimeoutMs: 1000,
    });
    let settled = false;
    const pending = connection
      .connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => false,
        onConnectionStateChange: (state) => states.push(state.status),
      })
      .then(() => {
        settled = true;
      });
    const client = sdkMock.MockWSClient.instances[0];
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(connection.isConnected()).toBe(false);

    client.emit('authenticated');
    await pending;
    expect(connection.isConnected()).toBe(true);
    expect(states).toEqual(['connecting', 'connected']);

    client.emit('reconnecting', 2);
    expect(connection.isConnected()).toBe(false);
    expect(states.at(-1)).toBe('reconnecting');
    client.emit('authenticated');
    expect(connection.isConnected()).toBe(true);
  });

  test('authentication timeout rejects and closes the transport', async () => {
    const connection = createWeComConnection({
      botId: 'bot-1',
      secret: 'secret-1',
      authTimeoutMs: 5,
    });
    await expect(
      connection.connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => false,
      }),
    ).rejects.toThrow('authentication timed out');
    expect(sdkMock.MockWSClient.instances[0].disconnect).toHaveBeenCalled();
    expect(connection.isConnected()).toBe(false);
  });

  test('unauthorized and resolver-rejected messages have no business side effects', async () => {
    const unauthorized = await connect({
      isChatAuthorized: vi.fn(() => false),
      resolveEffectiveChatJid: vi.fn(() => {
        throw new Error('must not route');
      }),
    });
    unauthorized.client.emit('message.text', frame({ reqId: 'unauthorized' }));
    await vi.waitFor(() =>
      expect(unauthorized.client.replyStream).toHaveBeenCalled(),
    );
    expect(unauthorized.opts.onNewChat).not.toHaveBeenCalled();
    expect(unauthorized.opts.resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(broadcastNewMessage).not.toHaveBeenCalled();
    expect(notifyNewImMessage).not.toHaveBeenCalled();

    await unauthorized.connection.disconnect();
    vi.clearAllMocks();
    const rejected = await connect({
      resolveEffectiveChatJid: vi.fn(() => null),
    });
    rejected.client.emit('message.text', frame({ reqId: 'rejected' }));
    await vi.waitFor(() =>
      expect(rejected.opts.resolveEffectiveChatJid).toHaveBeenCalled(),
    );
    expect(rejected.opts.onNewChat).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('pairing is consumed before routing and persistence', async () => {
    const onPairAttempt = vi.fn(async () => true);
    const connected = await connect({
      isChatAuthorized: vi.fn(() => false),
      onPairAttempt,
      resolveEffectiveChatJid: vi.fn(() => {
        throw new Error('must not route pairing');
      }),
    });
    connected.client.emit(
      'message.text',
      frame({ reqId: 'pair', content: '/pair CODE-1' }),
    );
    await vi.waitFor(() =>
      expect(connected.client.replyStream).toHaveBeenCalled(),
    );
    expect(connected.opts.resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(connected.opts.onNewChat).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(connected.client.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: 'pair' } }),
      expect.stringMatching(/^reply-/),
      expect.stringContaining('配对成功'),
      true,
    );
  });

  test('applies stale filtering, bounded msgid dedup, and in-flight exclusion', async () => {
    const connected = await connect({
      ignoreMessagesBefore: Date.now() - 1000,
    });
    connected.client.emit(
      'message.text',
      frame({ reqId: 'old', createTime: Math.floor(Date.now() / 1000) - 3600 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeMessageDirect).not.toHaveBeenCalled();

    const duplicate = frame({ reqId: 'same', msgId: 'same' });
    connected.client.emit('message.text', duplicate);
    connected.client.emit('message.text', duplicate);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
  });

  test('freezes the original req_id for concurrent messages in one chat', async () => {
    const connected = await connect();
    connected.client.emit(
      'message.text',
      frame({ reqId: 'req-a', msgId: 'a' }),
    );
    connected.client.emit(
      'message.text',
      frame({ reqId: 'req-b', msgId: 'b' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(2));
    const inputA = vi.mocked(storeMessageDirect).mock.calls[0][0];
    const inputB = vi.mocked(storeMessageDirect).mock.calls[1][0];

    const sessionA = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputA,
    );
    const sessionB = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputB,
    );
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    await sessionB!.complete('answer B');
    await sessionA!.complete('answer A');

    const finalCalls = connected.client.replyStream.mock.calls.filter(
      (call) => call[3] === true,
    );
    expect(finalCalls.map((call) => call[0].headers.req_id)).toEqual([
      'req-b',
      'req-a',
    ]);
    // A cached frame can be claimed only once.
    await expect(
      connected.connection.createStreamingSession('c2c:user-1', inputA),
    ).resolves.toBeUndefined();
  });

  test('throws when unauthenticated and propagates provider ACK failures', async () => {
    const connection = createWeComConnection({
      botId: 'bot',
      secret: 'secret',
    });
    await expect(connection.sendMessage('c2c:user', 'hello')).rejects.toThrow(
      'not authenticated',
    );

    const connected = await connect();
    connected.client.sendMessage.mockRejectedValueOnce(new Error('ACK failed'));
    await expect(
      connected.connection.sendMessage('c2c:user-1', 'hello'),
    ).rejects.toThrow('ACK failed');
  });

  test('propagates failure when both streaming finalization and fallback fail', async () => {
    const connected = await connect();
    connected.client.emit('message.text', frame({ reqId: 'req-fail' }));
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    const inputId = vi.mocked(storeMessageDirect).mock.calls[0][0];
    const session = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputId,
    );
    connected.client.replyStream.mockRejectedValueOnce(new Error('stream ACK'));
    connected.client.sendMessage.mockRejectedValueOnce(new Error('send ACK'));
    await expect(session!.complete('answer')).rejects.toThrow('send ACK');
  });
});

describe('WeCom UTF-8 byte limits', () => {
  test('paginates Unicode markdown without exceeding 20480 bytes', () => {
    const input = `${'企业微信🙂'.repeat(5000)}\n${'tail '.repeat(2000)}`;
    const pages = splitWeComMarkdown(input, WECOM_MARKDOWN_MAX_BYTES - 64);
    expect(pages.length).toBeGreaterThan(1);
    expect(
      pages.every((page) => Buffer.byteLength(page, 'utf8') <= 20_416),
    ).toBe(true);
    expect(pages.join('').replace(/\s/g, '')).toBe(input.replace(/\s/g, ''));
  });

  test('truncates streaming previews on code-point boundaries', () => {
    const preview = truncateWeComUtf8('🙂'.repeat(10_000));
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(
      WECOM_MARKDOWN_MAX_BYTES,
    );
    expect(preview).not.toContain('\uFFFD');
    expect(preview).toContain('完成后将分段发送');
  });
});
