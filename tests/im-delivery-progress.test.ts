import { describe, expect, test, vi } from 'vitest';

import {
  PartialChannelDeliveryError,
  PhysicalDeliveryTracker,
} from '../src/im-delivery-progress.js';

describe('PhysicalDeliveryTracker', () => {
  test('preserves the original error before any provider ACK', async () => {
    const failure = new Error('connect failed before accept');
    const tracker = new PhysicalDeliveryTracker(2);

    await expect(tracker.send(async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  test('fences an acknowledged prefix when a later mutation fails', async () => {
    const tail = new Error('second chunk failed before accept');
    const first = vi.fn(async () => {});
    const tracker = new PhysicalDeliveryTracker(2);

    await tracker.send(first);
    let failure: unknown;
    try {
      await tracker.send(async () => Promise.reject(tail));
    } catch (error) {
      failure = error;
    }

    expect(first).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(PartialChannelDeliveryError);
    expect(failure).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      outcome: 'uncertain',
      deliveredOutputs: 1,
      totalOutputs: 2,
      cause: tail,
    });
  });
});
