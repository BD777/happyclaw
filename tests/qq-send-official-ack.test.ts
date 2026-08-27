import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { syntheticChannelProviderAck } from '../src/channel-outbox-runtime-scope.js';

const https = vi.hoisted(() => {
  let messageBody = JSON.stringify({
    id: 'official-1',
    timestamp: '2026-08-27T00:00:00Z',
  });
  return {
    setMessageBody(body: string) {
      messageBody = body;
    },
    request: vi.fn(
      (
        opts: { hostname?: string; path?: string },
        cb: (res: {
          statusCode: number;
          on: (event: string, fn: (...args: any[]) => void) => unknown;
        }) => void,
      ) => {
        const path = String(opts.path || '');
        const hostname = String(opts.hostname || '');
        const isToken =
          hostname.includes('bots.qq.com') ||
          path.includes('getAppAccessToken');
        const isMessages = path.includes('/messages');
        const payload = isToken
          ? JSON.stringify({ access_token: 'qq-token', expires_in: 7200 })
          : isMessages
            ? messageBody
            : JSON.stringify({ file_info: 'file-info-1', ttl: 600 });
        const res = {
          statusCode: 200,
          on(event: string, fn: (...args: any[]) => void) {
            if (event === 'data') fn(Buffer.from(payload));
            if (event === 'end') fn();
            return res;
          },
        };
        return {
          on: vi.fn(),
          setTimeout: vi.fn(),
          write: vi.fn(),
          end() {
            cb(res);
          },
          destroy: vi.fn(),
        };
      },
    ),
  };
});

vi.mock('node:https', () => ({ default: https, request: https.request }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createQQConnection } = await import('../src/qq.js');

describe('QQ send official ACK (outbox)', () => {
  let connection: ReturnType<typeof createQQConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    https.setMessageBody(
      JSON.stringify({ id: 'official-1', timestamp: '2026-08-27T00:00:00Z' }),
    );
    connection = createQQConnection({ appId: 'app', appSecret: 'secret' });
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  });

  async function sendViaOutbox(text = 'hello') {
    let delivered: string | null = null;
    try {
      await connection!.sendMessage('c2c:user-openid', text);
      delivered = syntheticChannelProviderAck({
        turnRunId: 'turn-1',
        ordinal: 1,
        payloadHash: 'payload',
      });
    } catch (err) {
      return { delivered, error: err };
    }
    return { delivered, error: null };
  }

  test.each(['', '<html>ok</html>', '{broken'])(
    '200 %j throws and outbox is not delivered',
    async (body) => {
      https.setMessageBody(body);
      const result = await sendViaOutbox();
      expect(result.error).toBeTruthy();
      expect(result.delivered).toBeNull();
    },
  );

  test('200 {id, timestamp} still delivers', async () => {
    const result = await sendViaOutbox();
    expect(result.error).toBeNull();
    expect(result.delivered).toMatch(/^happyclaw-synthetic:/);
  });
});
