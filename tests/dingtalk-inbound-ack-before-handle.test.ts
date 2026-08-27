import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class MockDWClient {
    static instances: MockDWClient[] = [];
    listener:
      | ((downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void)
      | null = null;
    registerCallbackListener = vi.fn(
      (
        _topic: string,
        listener: (downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void,
      ) => {
        this.listener = listener;
        return this;
      },
    );
    socketCallBackResponse = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
    constructor(public options: Record<string, unknown>) {
      MockDWClient.instances.push(this);
    }
  }
  return { MockDWClient };
});

vi.mock('dingtalk-stream', () => ({
  DWClient: sdk.MockDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
}));

vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));

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
import {
  createDingTalkConnection,
  type DingTalkConnectOpts,
} from '../src/dingtalk.js';

type MockClient = InstanceType<typeof sdk.MockDWClient>;

function robotDownstream(input: {
  messageId?: string;
  msgId?: string;
  content?: string;
  senderId?: string;
}) {
  const senderId = input.senderId ?? 'staff-1';
  return {
    headers: { messageId: input.messageId ?? 'stream-msg-1' },
    data: JSON.stringify({
      conversationId: senderId,
      conversationType: '1',
      msgId: input.msgId ?? 'dt-msg-1',
      senderId,
      senderNick: '钉钉用户',
      senderStaffId: senderId,
      createAt: Date.now(),
      msgtype: 'text',
      text: { content: input.content ?? 'hello from dingtalk' },
    }),
  };
}

async function connect(): Promise<{
  client: MockClient;
  connection: ReturnType<typeof createDingTalkConnection>;
}>;
async function connect(overrides: Partial<DingTalkConnectOpts>): Promise<{
  client: MockClient;
  connection: ReturnType<typeof createDingTalkConnection>;
}>;
async function connect(overrides: Partial<DingTalkConnectOpts> = {}): Promise<{
  client: MockClient;
  connection: ReturnType<typeof createDingTalkConnection>;
}> {
  const connection = createDingTalkConnection({
    clientId: 'ding-client',
    clientSecret: 'ding-secret',
  });
  const ok = await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => true,
    resolveEffectiveChatJid: (jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    }),
    onMessagePersisted: vi.fn(),
    ...overrides,
  });
  expect(ok).toBe(true);
  const client = sdk.MockDWClient.instances.at(-1);
  if (!client?.listener) {
    throw new Error('DingTalk callback listener was not registered');
  }
  return { client, connection };
}

async function deliver(
  client: MockClient,
  input: Parameters<typeof robotDownstream>[0] = {},
) {
  await client.listener!(robotDownstream(input));
}

describe('DingTalk inbound Stream ACK must not precede handle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.MockDWClient.instances.length = 0;
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('does not ACK when storeMessageDirect throws, then persists and ACKs on redelivery', async () => {
    vi.mocked(storeMessageDirect)
      .mockImplementationOnce(() => {
        throw new Error('database temporarily unavailable');
      })
      .mockImplementation(() => 'stored');

    const { client } = await connect();

    await deliver(client);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));

    expect(client.socketCallBackResponse).not.toHaveBeenCalled();

    await deliver(client);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(2));

    expect(client.socketCallBackResponse).toHaveBeenCalledTimes(1);
    expect(client.socketCallBackResponse).toHaveBeenCalledWith('stream-msg-1', {
      success: true,
    });
  });

  test('ACKs only after inbound persist succeeds', async () => {
    const order: string[] = [];
    vi.mocked(storeMessageDirect).mockImplementation(() => {
      order.push('store');
      return 'stored';
    });

    const { client } = await connect();
    client.socketCallBackResponse.mockImplementation(() => {
      order.push('ack');
    });

    await deliver(client);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));

    expect(order).toEqual(['store', 'ack']);
    expect(client.socketCallBackResponse).toHaveBeenCalledWith('stream-msg-1', {
      success: true,
    });
  });

  test('an in-flight redelivery awaits the shared attempt before either callback ACKs', async () => {
    let resolvePair!: (paired: boolean) => void;
    const onPairAttempt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePair = resolve;
        }),
    );
    const { client } = await connect({
      isChatAuthorized: () => false,
      onPairAttempt,
    });
    const input = { content: '/pair CODE-1' };

    const first = client.listener!(robotDownstream(input));
    await vi.waitFor(() => expect(onPairAttempt).toHaveBeenCalledTimes(1));
    const redelivery = client.listener!(robotDownstream(input));
    await Promise.resolve();

    expect(client.socketCallBackResponse).not.toHaveBeenCalled();
    expect(onPairAttempt).toHaveBeenCalledTimes(1);

    resolvePair(true);
    await Promise.all([first, redelivery]);
    expect(client.socketCallBackResponse).toHaveBeenCalledTimes(2);

    await client.listener!(robotDownstream(input));
    expect(onPairAttempt).toHaveBeenCalledTimes(1);
    expect(client.socketCallBackResponse).toHaveBeenCalledTimes(3);
  });

  test('an in-flight failure leaves every concurrent delivery unacknowledged', async () => {
    let rejectPair!: (err: Error) => void;
    const onPairAttempt = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectPair = reject;
        }),
    );
    const { client } = await connect({
      isChatAuthorized: () => false,
      onPairAttempt,
    });
    const input = { content: '/pair CODE-2' };

    const first = client.listener!(robotDownstream(input));
    await vi.waitFor(() => expect(onPairAttempt).toHaveBeenCalledTimes(1));
    const redelivery = client.listener!(robotDownstream(input));
    rejectPair(new Error('pairing database unavailable'));
    await Promise.all([first, redelivery]);

    expect(onPairAttempt).toHaveBeenCalledTimes(1);
    expect(client.socketCallBackResponse).not.toHaveBeenCalled();
  });

  test('post-persist notification failures do not replay durable messages', async () => {
    vi.mocked(notifyNewImMessage).mockImplementationOnce(() => {
      throw new Error('wake signal unavailable');
    });
    const onMessagePersisted = vi.fn(() => {
      throw new Error('observer unavailable');
    });
    const { client } = await connect({ onMessagePersisted });

    await deliver(client);
    await deliver(client);

    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(onMessagePersisted).toHaveBeenCalledTimes(1);
    expect(client.socketCallBackResponse).toHaveBeenCalledTimes(2);
  });

  test('disconnect fences immediately but waits for a non-abortable inbound callback', async () => {
    let resolvePair!: (paired: boolean) => void;
    const onPairAttempt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePair = resolve;
        }),
    );
    const { client, connection } = await connect({
      isChatAuthorized: () => false,
      onPairAttempt,
    });
    const delivery = client.listener!(
      robotDownstream({ content: '/pair WAIT-FOR-DISCONNECT' }),
    );
    await vi.waitFor(() => expect(onPairAttempt).toHaveBeenCalledTimes(1));

    let disconnected = false;
    const disconnect = connection.disconnect().then(() => {
      disconnected = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(disconnected).toBe(false);
    resolvePair(true);
    await Promise.all([delivery, disconnect]);

    expect(client.socketCallBackResponse).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('disconnect aborts an active media response and suppresses persistence and ACK', async () => {
    let responseStarted = false;
    let requestDestroyed = false;
    vi.spyOn(https, 'request').mockImplementation(
      (_options: any, callback?: any) => {
        let res:
          | (EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
              destroy: () => void;
            })
          | undefined;
        const req = new EventEmitter() as EventEmitter & {
          end: () => void;
          setTimeout: () => void;
          destroy: () => void;
        };
        req.setTimeout = () => undefined;
        req.destroy = () => {
          requestDestroyed = true;
          res?.destroy();
        };
        req.end = () => {
          res = new EventEmitter() as typeof res & {
            statusCode: number;
            headers: Record<string, string>;
            destroy: () => void;
          };
          res.statusCode = 200;
          res.headers = {};
          res.destroy = () => undefined;
          callback?.(res);
          responseStarted = true;
          res.emit('data', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        };
        return req as any;
      },
    );
    const { client, connection } = await connect();
    const delivery = client.listener!({
      headers: { messageId: 'stream-media-1' },
      data: JSON.stringify({
        conversationId: 'staff-1',
        conversationType: '1',
        msgId: 'dt-media-1',
        senderId: 'staff-1',
        senderNick: '钉钉用户',
        senderStaffId: 'staff-1',
        createAt: Date.now(),
        msgtype: 'image',
        image: { contentUrl: 'https://cdn.example/hanging.jpg' },
      }),
    });
    await vi.waitFor(() => expect(responseStarted).toBe(true));

    await connection.disconnect();
    await delivery;

    expect(requestDestroyed).toBe(true);
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(client.socketCallBackResponse).not.toHaveBeenCalled();
  });

  test('a stale listener cannot ACK through a newly connected client', async () => {
    const first = await connect();
    const staleListener = first.client.listener!;
    await first.connection.disconnect();

    const ok = await first.connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onMessagePersisted: vi.fn(),
    });
    expect(ok).toBe(true);
    const currentClient = sdk.MockDWClient.instances.at(-1)!;

    await staleListener(
      robotDownstream({
        messageId: 'stale-stream',
        msgId: 'stale-provider-message',
      }),
    );
    expect(first.client.socketCallBackResponse).not.toHaveBeenCalled();
    expect(currentClient.socketCallBackResponse).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();

    await currentClient.listener!(
      robotDownstream({
        messageId: 'fresh-stream',
        msgId: 'fresh-provider-message',
      }),
    );
    expect(currentClient.socketCallBackResponse).toHaveBeenCalledWith(
      'fresh-stream',
      { success: true },
    );
    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    await first.connection.disconnect();
  });
});
