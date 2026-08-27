import { beforeEach, describe, expect, test, vi } from 'vitest';

const https = vi.hoisted(() => {
  const posts: Array<{ hostname: string; path: string; body: string }> = [];
  return {
    posts,
    request: vi.fn(
      (
        opts: { hostname?: string; path?: string; method?: string },
        cb: (res: {
          statusCode: number;
          on: (event: string, fn: (...args: any[]) => void) => unknown;
        }) => void,
      ) => {
        const path = String(opts.path || '');
        const isToken = path.includes('/gettoken');
        const payload = isToken
          ? JSON.stringify({
              errcode: 0,
              access_token: 'ding-token',
              expires_in: 7200,
            })
          : JSON.stringify({ errcode: 0 });
        let written = '';
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
          write(chunk: string) {
            written += chunk;
          },
          end() {
            if (!isToken) {
              https.posts.push({
                hostname: String(opts.hostname || ''),
                path,
                body: written,
              });
            }
            cb(res);
          },
        };
      },
    ),
  };
});

vi.mock('node:https', () => ({ default: https, request: https.request }));

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

const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  isDatabaseInitialized: () => false,
}));
vi.mock('../src/db.js', () => db);
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createDingTalkConnection } = await import('../src/dingtalk.js');

type MockClient = InstanceType<typeof sdk.MockDWClient>;

function robotDownstream(input: {
  content?: string;
  senderId?: string;
  sessionWebhook?: string;
}) {
  const senderId = input.senderId ?? 'staff-1';
  return {
    headers: { messageId: 'stream-msg-1' },
    data: JSON.stringify({
      conversationId: senderId,
      conversationType: '1',
      msgId: `dt-${input.content ?? 'hello'}`,
      senderId,
      senderNick: '钉钉用户',
      senderStaffId: senderId,
      createAt: Date.now(),
      msgtype: 'text',
      text: { content: input.content ?? 'hello from dingtalk' },
      sessionWebhook: input.sessionWebhook ?? 'https://webhook.example/session',
    }),
  };
}

async function connect(opts: {
  authorized: boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
}): Promise<{
  client: MockClient;
  connection: ReturnType<typeof createDingTalkConnection>;
}> {
  const connection = createDingTalkConnection({
    clientId: 'ding-client',
    clientSecret: 'ding-secret',
  });
  const ok = await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => opts.authorized,
    onPairAttempt: opts.onPairAttempt,
    resolveEffectiveChatJid: (jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    }),
  });
  expect(ok).toBe(true);
  const client = sdk.MockDWClient.instances.at(-1);
  if (!client?.listener) {
    throw new Error('DingTalk callback listener was not registered');
  }
  return { client, connection };
}

function webhookTexts(): string[] {
  return https.posts
    .map((post) => {
      try {
        const body = JSON.parse(post.body) as {
          text?: { content?: string };
        };
        return body.text?.content ?? '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

describe('DingTalk unpaired deny /pair hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.MockDWClient.instances.length = 0;
    https.posts.length = 0;
    db.storeMessageDirect.mockImplementation(() => 'stored');
  });

  test('unpaired C2C text sends the Chinese /pair hint via sessionWebhook', async () => {
    const { client } = await connect({ authorized: false });
    await client.listener!(
      robotDownstream({
        content: 'hi',
        sessionWebhook: 'https://hook/session',
      }),
    );
    await vi.waitFor(() => expect(webhookTexts().length).toBeGreaterThan(0));
    expect(webhookTexts()).toContain(
      '此聊天尚未配对。请在 Web 设置页生成配对码，然后发送 /pair <code>。',
    );
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('/pair good still replies paired', async () => {
    const onPairAttempt = vi.fn(async () => true);
    const { client } = await connect({ authorized: false, onPairAttempt });
    await client.listener!(
      robotDownstream({
        content: '/pair ABC123',
        sessionWebhook: 'https://hook/session',
      }),
    );
    await vi.waitFor(() =>
      expect(webhookTexts()).toContain('配对成功！此聊天已连接到你的账号。'),
    );
    expect(onPairAttempt).toHaveBeenCalled();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('/pair bad still replies pair_rejected', async () => {
    const onPairAttempt = vi.fn(async () => false);
    const { client } = await connect({ authorized: false, onPairAttempt });
    await client.listener!(
      robotDownstream({
        content: '/pair BADCODE',
        sessionWebhook: 'https://hook/session',
      }),
    );
    await vi.waitFor(() =>
      expect(webhookTexts()).toContain(
        '配对码无效或已过期，请在 Web 设置页重新生成。',
      ),
    );
    expect(onPairAttempt).toHaveBeenCalled();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('authorized C2C text persists and does not send the /pair hint', async () => {
    const { client } = await connect({ authorized: true });
    await client.listener!(
      robotDownstream({
        content: 'already paired',
        sessionWebhook: 'https://hook/session',
      }),
    );
    await vi.waitFor(() => expect(db.storeMessageDirect).toHaveBeenCalled());
    expect(webhookTexts()).not.toContain(
      '此聊天尚未配对。请在 Web 设置页生成配对码，然后发送 /pair <code>。',
    );
  });
});
