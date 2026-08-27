import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { DiscordStreamingEditController } from '../src/discord-streaming-edit.js';
import { QQStreamingController } from '../src/qq-streaming-card.js';
import { WeComStreamingController } from '../src/wecom-streaming.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';
import { preAcceptImDeliveryError } from '../src/im-send-retry-policy.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('streaming finalize must not send a second full copy', () => {
  test('Discord: preview flush + failed final edit does not fallback-send', async () => {
    vi.useFakeTimers();

    const fallbackSend = vi.fn(async () => {});
    const finalizeError = new Error('discord finalize edit failed');
    let editCount = 0;
    const message = {
      id: 'msg-preview',
      edit: vi.fn(async (_content: string) => {
        editCount += 1;
        // First edit is the preview flush; the finalize edit fails.
        if (editCount > 1) throw finalizeError;
        return message;
      }),
    };
    const channel = {
      send: vi.fn(async (_content: string) => message),
    };

    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });
    ctrl.append('Hello from the preview');
    await vi.advanceTimersByTimeAsync(600);

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(fallbackSend).not.toHaveBeenCalled();

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        cause: finalizeError,
      },
    });
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
    });
    expect(message.edit).toHaveBeenCalledTimes(2);
    expect(fallbackSend).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test('Discord: pre-accept final failure delegates static fallback to the host', async () => {
    const fallbackSend = vi.fn(async () => {});
    const message = {
      id: 'msg-placeholder',
      edit: vi.fn(async () => {
        throw preAcceptImDeliveryError('discord finalize edit failed');
      }),
    };
    const channel = {
      send: vi.fn(async (_content: string) => message),
    };

    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });
    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toMatchObject({ deliveryPhase: 'pre_accept' });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('Discord: uncertain first final edit never falls back', async () => {
    const uncertain = new Error('Discord edit ACK lost');
    const fallbackSend = vi.fn(async () => {});
    const message = {
      id: 'msg-placeholder',
      edit: vi.fn(async () => Promise.reject(uncertain)),
    };
    const channel = {
      send: vi.fn(async () => message),
    };
    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });

    const first = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(first).toEqual({ acknowledged: false, error: uncertain });
    expect(repeated).toEqual({ acknowledged: false, error: uncertain });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('Discord: no-preview multi-chunk partial send is fenced without full fallback', async () => {
    const continuationError = new Error('discord continuation failed');
    const fallbackSend = vi.fn(async () => {});
    const message = {
      id: 'msg-placeholder',
      edit: vi.fn(async () => message),
    };
    let sends = 0;
    const channel = {
      send: vi.fn(async () => {
        sends += 1;
        if (sends > 1) throw continuationError;
        return message;
      }),
    };

    const ctrl = new DiscordStreamingEditController(channel as any, {
      fallbackSend,
    });
    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'x'.repeat(3000),
      true,
      'finalize failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
        cause: continuationError,
      },
    });
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
    });
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(message.edit).toHaveBeenCalledOnce();
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('QQ: preview flush + failed DONE chunk does not fallback-send', async () => {
    vi.useFakeTimers();

    const fallbackSend = vi.fn(async () => {});
    const streamCalls: Array<{ input_state: number; content_raw: string }> = [];
    const sendStreamChunk = vi.fn(async (_openid: string, params: any) => {
      streamCalls.push({
        input_state: params.input_state,
        content_raw: params.content_raw,
      });
      if (params.input_state === 10) {
        throw new Error('qq finalize DONE failed');
      }
      return { id: 'stream-msg-1' };
    });

    const ctrl = new QQStreamingController({
      openid: 'user-openid',
      msgSeq: 1,
      sendStreamChunk,
      fallbackSend,
      passiveMsgId: 'passive-1',
    });
    ctrl.append('Hello from the preview');
    await vi.advanceTimersByTimeAsync(600);

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].input_state).toBe(1);
    expect(fallbackSend).not.toHaveBeenCalled();

    await expect(
      ctrl.complete('Hello from the preview — final'),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: expect.objectContaining({ message: 'qq finalize DONE failed' }),
    });

    expect(streamCalls.some((c) => c.input_state === 10)).toBe(true);
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: preview flush + failed DONE stream does not fallback-send', async () => {
    vi.useFakeTimers();

    const fallbackSend = vi.fn(async () => {});
    const finalizeError = new Error('wecom finalize DONE failed');
    const streamCalls: Array<{ content: string; finish: boolean }> = [];
    const sendStream = vi.fn(async (content: string, finish: boolean) => {
      streamCalls.push({ content, finish });
      if (finish) throw finalizeError;
    });

    const ctrl = new WeComStreamingController({
      chatId: 'chat-1',
      sendStream,
      fallbackSend,
    });
    ctrl.append('Hello from the preview');
    await vi.advanceTimersByTimeAsync(800);

    expect(streamCalls).toEqual([
      { content: 'Hello from the preview', finish: false },
    ]);
    expect(fallbackSend).not.toHaveBeenCalled();

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );

    expect(finalized).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        cause: finalizeError,
      },
    });
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Hello from the preview — final',
      true,
      'finalize failed',
    );
    expect(repeated).toMatchObject({
      acknowledged: false,
      error: { code: 'CHANNEL_DELIVERY_PARTIAL' },
    });
    expect(streamCalls).toContainEqual({
      content: 'Hello from the preview — final',
      finish: true,
    });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: pre-accept first DONE delegates static fallback to the host', async () => {
    const fallbackSend = vi.fn(async () => {});
    const sendStream = vi.fn(async () => {
      throw preAcceptImDeliveryError('wecom finalize DONE failed');
    });

    const ctrl = new WeComStreamingController({
      chatId: 'chat-1',
      sendStream,
      fallbackSend,
    });
    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toMatchObject({ deliveryPhase: 'pre_accept' });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: uncertain first DONE never falls back and remains unacknowledged', async () => {
    const uncertain = new Error('WeCom DONE ACK was lost');
    const fallbackSend = vi.fn(async () => {});
    const ctrl = new WeComStreamingController({
      chatId: 'chat-1',
      sendStream: vi.fn(async () => Promise.reject(uncertain)),
      fallbackSend,
    });

    const first = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );
    const repeated = await finalizeChannelCardAfterDelivery(
      ctrl,
      'Only the final text',
      true,
      'finalize failed',
    );

    expect(first).toEqual({ acknowledged: false, error: uncertain });
    expect(repeated).toEqual({ acknowledged: false, error: uncertain });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  test('WeCom: oversized final close failure fences the preview before pagination', async () => {
    vi.useFakeTimers();
    try {
      const closeError = new Error('WeCom oversized close ACK lost');
      let calls = 0;
      const sendStream = vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw closeError;
      });
      const fallbackSend = vi.fn(async () => {});
      const ctrl = new WeComStreamingController({
        chatId: 'chat-1',
        sendStream,
        fallbackSend,
      });

      ctrl.append('visible preview');
      await vi.advanceTimersByTimeAsync(800);
      const finalized = await finalizeChannelCardAfterDelivery(
        ctrl,
        'x'.repeat(21_000),
        true,
        'finalize failed',
      );

      expect(finalized).toMatchObject({
        acknowledged: false,
        error: {
          code: 'CHANNEL_DELIVERY_PARTIAL',
          cause: closeError,
        },
      });
      expect(sendStream).toHaveBeenCalledTimes(2);
      expect(fallbackSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
