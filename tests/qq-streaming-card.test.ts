import { describe, expect, test, vi } from 'vitest';

import { QQStreamingController } from '../src/qq-streaming-card.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

describe('QQ streaming passive rejection fallback', () => {
  test('definitive start rejection falls back once with the final text', async () => {
    const rejection = new Error('provider rejected msg_id');
    const fallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 2,
      passiveMsgId: 'message',
      sendStreamChunk: vi.fn(async () => {
        throw rejection;
      }),
      fallbackSend: fallback,
      onDefinitiveRejection: (error) => error === rejection,
    });

    controller.append('partial');
    await controller.complete('partial and final');

    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith('partial and final');
  });

  test('uncertain start never falls back or reuses the sequence', async () => {
    const timeout = new Error('socket timed out after write');
    const send = vi.fn(async () => {
      throw timeout;
    });
    const fallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 2,
      passiveMsgId: 'message',
      sendStreamChunk: send,
      fallbackSend: fallback,
      onDefinitiveRejection: () => false,
    });

    controller.append('partial');
    await expect(controller.complete('partial and final')).rejects.toBe(
      timeout,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  test('failed plain fallback rejects finalization so the cursor is not acknowledged', async () => {
    const rejection = new Error('verified expired reference');
    const fallbackFailure = new Error('active push rejected');
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 1,
      passiveMsgId: 'message',
      sendStreamChunk: vi.fn(async () => {
        throw rejection;
      }),
      fallbackSend: vi.fn(async () => {
        throw fallbackFailure;
      }),
      onDefinitiveRejection: (error) => error === rejection,
    });
    controller.append('partial');

    const finalized = await finalizeChannelCardAfterDelivery(
      controller,
      'complete answer',
      true,
      'delivery failed',
    );

    expect(finalized).toEqual({
      acknowledged: false,
      error: fallbackFailure,
    });
    expect(controller.isActive()).toBe(false);
  });
});
