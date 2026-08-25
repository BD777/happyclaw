import type { Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const crypto = vi.hoisted(() => ({
  downloadAndDecryptMedia: vi.fn(async () => Buffer.from('media-bytes')),
  uploadMediaBuffer: vi.fn(),
}));
const downloader = vi.hoisted(() => ({
  saveDownloadedFile: vi.fn(async (_folder, _ch, fileName) => `ws/${fileName}`),
  MAX_FILE_SIZE: 20 * 1024 * 1024,
}));
const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
  isDatabaseInitialized: () => false,
}));
const notify = vi.hoisted(() => ({ notifyNewImMessage: vi.fn() }));

vi.mock('../src/wechat-crypto.js', () => crypto);
vi.mock('../src/im-downloader.js', () => downloader);
vi.mock('../src/db.js', () => db);
vi.mock('../src/message-notifier.js', () => notify);
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWeChatConnection } = await import('../src/wechat.js');

function waitUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function inboundMsg(item: Record<string, unknown>, id: string) {
  return {
    message_id: id,
    from_user_id: 'wxid_user1',
    create_time_ms: Date.now(),
    context_token: 'tok',
    item_list: [item],
  };
}

function fetchOnceThenHang(firstBody: unknown): ReturnType<typeof vi.fn> {
  let first = true;
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal | null }) => {
    if (first) {
      first = false;
      return Response.json(firstBody);
    }
    return waitUntilAborted(init?.signal);
  });
}

async function connectAndDrain(fetchMock: ReturnType<typeof vi.fn>) {
  const close = vi.fn(async () => undefined);
  const connection = createWeChatConnection(
    {
      botToken: 'secret-token',
      ilinkBotId: 'bot-identity@example',
    },
    {
      fetch: fetchMock as typeof fetch,
      createDispatcher: () => ({ close }) as unknown as Dispatcher,
      contextTokenStore: null,
      random: () => 0.5,
      now: () => Date.now(),
    },
  );
  try {
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveGroupFolder: () => '/tmp/wechat-ws',
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
    });
    await vi.waitFor(() => expect(db.storeMessageDirect).toHaveBeenCalled());
  } finally {
    await connection.disconnect();
  }
  return connection;
}

describe('WeChat inbound video CDN persist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crypto.downloadAndDecryptMedia.mockResolvedValue(
      Buffer.from('media-bytes'),
    );
    downloader.saveDownloadedFile.mockImplementation(
      async (_folder, _ch, fileName) => `ws/${fileName}`,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('type-5 video-only persists a workspace file', async () => {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 5,
            video_item: {
              media: {
                encrypt_query_param: 'q-video',
                aes_key: 'k-video',
              },
            },
          },
          'vid-1',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(downloader.saveDownloadedFile).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/视频/);
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/ws\//);
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });

  test('type 2 image still downloads', async () => {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: 'q-img',
                aes_key: 'k-img',
              },
            },
          },
          'img-1',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(downloader.saveDownloadedFile).toHaveBeenCalled();
  });

  test('type 4 PDF still downloads', async () => {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 4,
            file_item: {
              file_name: 'notes.pdf',
              media: {
                encrypt_query_param: 'q-pdf',
                aes_key: 'k-pdf',
              },
            },
          },
          'pdf-1',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(downloader.saveDownloadedFile).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/文件/);
  });
});
