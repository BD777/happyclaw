import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  type Listener = (downstream: {
    headers?: { messageId?: string };
    data: string;
  }) => Promise<void> | void;
  class MockDWClient {
    static instances: MockDWClient[] = [];
    listener: Listener | null = null;
    registerCallbackListener = vi.fn((_topic: string, listener: Listener) => {
      this.listener = listener;
    });
    socketCallBackResponse = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
    constructor() {
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

import {
  createDingTalkConnection,
  DingTalkPartialDeliveryError,
} from '../src/dingtalk.js';

describe('DingTalk multi-chunk physical delivery', () => {
  let groupSendCount = 0;
  let failGroupSendAt = 0;
  let c2cSendCount = 0;
  let failC2cSendAt = 0;

  beforeEach(() => {
    groupSendCount = 0;
    failGroupSendAt = 0;
    c2cSendCount = 0;
    failC2cSendAt = 0;
    sdk.MockDWClient.instances.length = 0;
    vi.spyOn(https, 'request').mockImplementation(
      (options: any, callback?: any) => {
        const requestPath = String(options?.path ?? '');
        const req = new EventEmitter() as EventEmitter & {
          write: () => void;
          end: () => void;
          setTimeout: () => void;
          destroy: () => void;
        };
        req.write = () => undefined;
        req.setTimeout = () => undefined;
        req.destroy = () => undefined;
        req.end = () => {
          let statusCode = 200;
          let body: Record<string, unknown>;
          if (requestPath.includes('/gettoken')) {
            body = {
              errcode: 0,
              access_token: 'token-1',
              expires_in: 7200,
            };
          } else if (requestPath.includes('/groupMessages/send')) {
            groupSendCount += 1;
            if (groupSendCount === failGroupSendAt) {
              statusCode = 503;
              body = {
                code: 'ServiceUnavailable',
                message: 'injected tail failure',
              };
            } else {
              body = { processQueryKey: `ack-${groupSendCount}` };
            }
          } else if (requestPath.includes('/oToMessages/batchSend')) {
            c2cSendCount += 1;
            if (c2cSendCount === failC2cSendAt) {
              statusCode = 503;
              body = {
                code: 'ServiceUnavailable',
                message: 'injected tail failure',
              };
            } else {
              body = {
                processQueryKey: `c2c-ack-${c2cSendCount}`,
                invalidStaffIdList: [],
                flowControlledStaffIdList: [],
              };
            }
          } else {
            throw new Error(`unexpected DingTalk request: ${requestPath}`);
          }
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
            destroy: () => void;
          };
          res.statusCode = statusCode;
          res.headers = {};
          res.destroy = () => undefined;
          callback?.(res);
          res.emit('data', Buffer.from(JSON.stringify(body)));
          res.emit('end');
        };
        return req as any;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connected() {
    const connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    await expect(
      connection.connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => true,
      }),
    ).resolves.toBe(true);
    return connection;
  }

  test('reports CHANNEL_DELIVERY_PARTIAL when a later chunk fails after an ACK', async () => {
    failGroupSendAt = 2;
    const connection = await connected();
    let failure: unknown;

    try {
      await connection.sendMessage('dingtalk:group:cid-1', 'x'.repeat(4500));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DingTalkPartialDeliveryError);
    expect(failure).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredChunks: 1,
      totalChunks: 2,
    });
    expect((failure as Error & { cause?: Error }).cause?.message).toContain(
      'HTTP failed (503)',
    );
    expect(groupSendCount).toBe(2);
    await connection.disconnect();
  });

  test('preserves the original error when no chunk received an ACK', async () => {
    failGroupSendAt = 1;
    const connection = await connected();

    await expect(
      connection.sendMessage('dingtalk:group:cid-1', 'x'.repeat(4500)),
    ).rejects.not.toMatchObject({ code: 'CHANNEL_DELIVERY_PARTIAL' });
    expect(groupSendCount).toBe(1);
    await connection.disconnect();
  });

  test('applies the same partial-delivery fence to persistent C2C chunks', async () => {
    failC2cSendAt = 2;
    const connection = await connected();
    const client = sdk.MockDWClient.instances.at(-1)!;
    await client.listener?.({
      headers: { messageId: 'route-stream-1' },
      data: JSON.stringify({
        conversationId: 'user-1',
        conversationType: '1',
        msgId: 'route-message-1',
        senderId: 'user-1',
        senderStaffId: 'staff-1',
        senderNick: 'Ada',
        createAt: Date.now(),
        // Unsupported content has no durable business side effect, but the
        // admitted callback still establishes the provider's C2C route.
        msgtype: 'unsupported-for-route-setup',
      }),
    });

    await expect(
      connection.sendMessage('dingtalk:c2c:user-1', 'x'.repeat(4500)),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredChunks: 1,
      totalChunks: 2,
    });
    expect(c2cSendCount).toBe(2);
    await connection.disconnect();
  });
});
