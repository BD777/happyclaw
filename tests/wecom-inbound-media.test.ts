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
    downloadFile = vi.fn();

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

vi.mock('../src/db.js', () => ({
  getMessage: vi.fn(() => null),
  sequenceInboundTimestampAfterChatTail: vi.fn(
    (_chatJid: string, proposedTimestamp: string) => proposedTimestamp,
  ),
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
  getMessage,
  sequenceInboundTimestampAfterChatTail,
  storeMessageDirect,
} from '../src/db.js';
import { notifyNewImMessage } from '../src/message-notifier.js';
import { createWeComConnection } from '../src/wecom.js';

type MockClient = InstanceType<typeof sdkMock.MockWSClient>;

function mediaFrame(input: {
  reqId: string;
  msgtype: string;
  chattype?: 'single' | 'group';
  userId?: string;
  chatId?: string;
  text?: string;
  voice?: string;
  imageUrl?: string;
  imageAeskey?: string;
  mixedText?: string;
  fileUrl?: string;
  videoUrl?: string;
}) {
  const chattype = input.chattype ?? 'single';
  const body: Record<string, unknown> = {
    msgid: input.reqId,
    aibotid: 'bot-1',
    chattype,
    chatid: chattype === 'group' ? (input.chatId ?? 'group-1') : undefined,
    from: { userid: input.userId ?? 'user-1' },
    create_time: Math.floor(Date.now() / 1000),
    msgtype: input.msgtype,
  };
  if (input.msgtype === 'text') body.text = { content: input.text ?? 'hello' };
  if (input.msgtype === 'voice') body.voice = { content: input.voice ?? '' };
  if (input.msgtype === 'image') {
    body.image = {
      url: input.imageUrl ?? 'https://example.com/a.jpg',
      aeskey: input.imageAeskey ?? 'k',
    };
  }
  if (input.msgtype === 'mixed') {
    body.mixed = {
      msg_item: [
        { msgtype: 'text', text: { content: input.mixedText ?? 'hello' } },
      ],
    };
  }
  if (input.msgtype === 'file') {
    body.file = {
      url: input.fileUrl ?? 'https://example.com/notes.pdf',
      aeskey: 'k',
    };
  }
  if (input.msgtype === 'video') {
    body.video = {
      url: input.videoUrl ?? 'https://example.com/clip.mp4',
      aeskey: 'k',
    };
  }
  return { headers: { req_id: input.reqId }, body } as any;
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
    onMessagePersisted: vi.fn(),
    ...overrides,
  };
  const pending = connection.connect(opts);
  const client = sdkMock.MockWSClient.instances.at(-1)!;
  client.emit('authenticated');
  await pending;
  return { connection, client, opts };
}

describe('WeCom inbound media persist/notify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMessage).mockReturnValue(null);
    vi.mocked(sequenceInboundTimestampAfterChatTail).mockImplementation(
      (_chatJid, proposedTimestamp) => proposedTimestamp,
    );
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    sdkMock.MockWSClient.instances.length = 0;
    sdkMock.req = 0;
  });

  test('authorized C2C voice persists transcript and notifies', async () => {
    const { client } = await connect();
    client.emit(
      'message.voice',
      mediaFrame({ reqId: 'voice-1', msgtype: 'voice', voice: '你好' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('你好');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('authorized C2C mixed persists text items and notifies', async () => {
    const { client } = await connect();
    client.emit(
      'message.mixed',
      mediaFrame({ reqId: 'mixed-1', msgtype: 'mixed', mixedText: 'hello' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('hello');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('authorized C2C image downloads and persists a picture marker', async () => {
    const { client } = await connect();
    client.downloadFile.mockResolvedValue({
      buffer: Buffer.from('img'),
      filename: 'a.jpg',
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-1', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(client.downloadFile).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[图片: a.jpg]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('unauthorized C2C voice does not persist', async () => {
    const { client } = await connect({
      isChatAuthorized: vi.fn(() => false),
    });
    client.emit(
      'message.voice',
      mediaFrame({ reqId: 'voice-deny', msgtype: 'voice', voice: '你好' }),
    );
    await vi.waitFor(() => expect(client.replyStream).toHaveBeenCalled());
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(notifyNewImMessage).not.toHaveBeenCalled();
  });

  test('group image is dropped because official media is C2C-only', async () => {
    const { client } = await connect();
    client.downloadFile.mockResolvedValue({
      buffer: Buffer.from('img'),
      filename: 'a.jpg',
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-g', msgtype: 'image', chattype: 'group' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(notifyNewImMessage).not.toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
  });

  test('authorized group mixed persists text items and notifies', async () => {
    const { client } = await connect();
    client.emit(
      'message.mixed',
      mediaFrame({
        reqId: 'mixed-g',
        msgtype: 'mixed',
        chattype: 'group',
        mixedText: 'group hello',
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('group hello');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('authorized C2C file downloads and persists exact file marker', async () => {
    const { client } = await connect();
    client.downloadFile.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      filename: 'notes.pdf',
    });
    client.emit(
      'message.file',
      mediaFrame({ reqId: 'file-1', msgtype: 'file' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(client.downloadFile).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[文件: notes.pdf]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('authorized C2C video downloads and persists exact video marker', async () => {
    const { client } = await connect();
    client.downloadFile.mockResolvedValue({
      buffer: Buffer.from('mp4'),
      filename: 'clip.mp4',
    });
    client.emit(
      'message.video',
      mediaFrame({ reqId: 'video-1', msgtype: 'video' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(client.downloadFile).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[视频消息]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('C2C image CDN-fail persists exact [图片]', async () => {
    const { client } = await connect();
    client.downloadFile.mockRejectedValue(new Error('cdn fail'));
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-fail', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(client.downloadFile).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[图片]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('C2C file CDN-fail persists exact [文件]', async () => {
    const { client } = await connect();
    client.downloadFile.mockRejectedValue(new Error('cdn fail'));
    client.emit(
      'message.file',
      mediaFrame({ reqId: 'file-fail', msgtype: 'file' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[文件]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('C2C video CDN-fail persists exact [视频消息]', async () => {
    const { client } = await connect();
    client.downloadFile.mockRejectedValue(new Error('cdn fail'));
    client.emit(
      'message.video',
      mediaFrame({ reqId: 'video-fail', msgtype: 'video' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[视频消息]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });
  test('existing authorized C2C text path still persists and notifies', async () => {
    const { client } = await connect();
    client.emit(
      'message.text',
      mediaFrame({ reqId: 'text-1', msgtype: 'text', text: 'hello' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('hello');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });
});
