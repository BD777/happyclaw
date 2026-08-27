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

const mediaStore = vi.hoisted(() => ({
  saveDownloadedFile: vi.fn(
    async (_folder: string, channel: string, fileName: string) =>
      `downloads/${channel}/${fileName}`,
  ),
}));

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
vi.mock('../src/im-downloader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/im-downloader.js')>()),
  saveDownloadedFile: mediaStore.saveDownloadedFile,
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
  mixedImageUrl?: string;
  fileUrl?: string;
  videoUrl?: string;
  createTime?: number;
}) {
  const chattype = input.chattype ?? 'single';
  const body: Record<string, unknown> = {
    msgid: input.reqId,
    aibotid: 'bot-1',
    chattype,
    chatid: chattype === 'group' ? (input.chatId ?? 'group-1') : undefined,
    from: { userid: input.userId ?? 'user-1' },
    create_time: input.createTime ?? Math.floor(Date.now() / 1000),
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
    const msgItems: Array<Record<string, unknown>> = [
      { msgtype: 'text', text: { content: input.mixedText ?? 'hello' } },
    ];
    if (input.mixedImageUrl) {
      msgItems.push({
        msgtype: 'image',
        image: { url: input.mixedImageUrl, aeskey: 'mixed-key' },
      });
    }
    body.mixed = {
      msg_item: msgItems,
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
    resolveGroupFolder: vi.fn(() => 'workspace-1'),
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
    mediaStore.saveDownloadedFile.mockImplementation(
      async (_folder, channel, fileName) => `downloads/${channel}/${fileName}`,
    );
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
    const imageBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    client.downloadFile.mockResolvedValue({
      buffer: imageBuffer,
      filename: 'mixed.jpg',
    });
    client.emit(
      'message.mixed',
      mediaFrame({
        reqId: 'mixed-1',
        msgtype: 'mixed',
        mixedText: 'hello',
        mixedImageUrl: 'https://example.com/mixed.jpg',
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      'hello\n[图片: downloads/wecom/mixed.jpg]',
    );
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storeMessageDirect.mock.calls[0][7].attachments)).toEqual(
      [
        {
          type: 'image',
          data: imageBuffer.toString('base64'),
          mimeType: 'image/jpeg',
        },
      ],
    );
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('authorized C2C image downloads and persists a picture marker', async () => {
    const { client } = await connect();
    client.downloadFile.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      filename: 'a.jpg',
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-1', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(client.downloadFile).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[图片: downloads/wecom/a.jpg]',
    );
    expect(storeMessageDirect.mock.calls[0][7].attachments).toBeTruthy();
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

  test('authorization rejects image before any download', async () => {
    const { client } = await connect({
      isChatAuthorized: vi.fn(() => false),
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-deny', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(client.replyStream).toHaveBeenCalled());
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(mediaStore.saveDownloadedFile).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('stale media is rejected before admission and download', async () => {
    const isChatAuthorized = vi.fn(() => true);
    const { client } = await connect({
      isChatAuthorized,
      ignoreMessagesBefore: Date.now(),
    });
    client.emit(
      'message.image',
      mediaFrame({
        reqId: 'image-stale',
        msgtype: 'image',
        createTime: Math.floor(Date.now() / 1000) - 60,
      }),
    );
    await Promise.resolve();
    expect(isChatAuthorized).not.toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('duplicate media callbacks download and persist only once', async () => {
    const { client } = await connect();
    client.downloadFile.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      filename: 'once.jpg',
    });
    const frame = mediaFrame({ reqId: 'image-duplicate', msgtype: 'image' });
    client.emit('message.image', frame);
    client.emit('message.image', frame);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
  });

  test('durable media replay is detected before download', async () => {
    vi.mocked(getMessage).mockReturnValue({ id: 'stored' } as any);
    const { client } = await connect();
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-durable', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(getMessage).toHaveBeenCalled());
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
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
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledWith(
      'workspace-1',
      'wecom',
      'notes.pdf',
      Buffer.from('pdf'),
    );
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[文件: downloads/wecom/notes.pdf]',
    );
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
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[视频: downloads/wecom/clip.mp4]',
    );
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
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[文件（下载失败）]');
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
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[视频（下载失败）]');
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
