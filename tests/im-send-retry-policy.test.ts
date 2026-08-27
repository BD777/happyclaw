import { describe, expect, test } from 'vitest';

import { imSendFailurePolicy } from '../src/im-send-retry-policy.js';
import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';
import { WeChatContextTokenError } from '../src/wechat-context-token.js';

describe('imSendFailurePolicy', () => {
  test.each(['missing', 'expired', 'quota_exhausted'] as const)(
    'does not retry or remove a healthy WeChat chat for %s context',
    (reason) => {
      expect(
        imSendFailurePolicy(new WeChatContextTokenError(reason, 'peer')),
      ).toEqual({
        retryable: false,
        countsTowardChannelRemoval: false,
      });
    },
  );

  test('recognizes a refresh requirement wrapped as an error cause', () => {
    const cause = new WeChatContextTokenError('missing', 'peer');
    expect(imSendFailurePolicy(new Error('adapter failed', { cause }))).toEqual(
      {
        retryable: false,
        countsTowardChannelRemoval: false,
      },
    );
  });

  test('keeps transient transport failures retryable and health-counted', () => {
    expect(imSendFailurePolicy(new Error('connection reset'))).toEqual({
      retryable: true,
      countsTowardChannelRemoval: true,
    });
  });

  test('does not automatically replay an accepted-but-unacknowledged delivery', () => {
    const cause = Object.assign(new Error('response lost'), {
      code: 'CHANNEL_DELIVERY_UNCERTAIN',
    });
    expect(imSendFailurePolicy(new Error('adapter failed', { cause }))).toEqual(
      {
        retryable: false,
        countsTowardChannelRemoval: false,
      },
    );
  });

  test('does not retry or remove a healthy channel after an explicit provider rejection', () => {
    expect(
      imSendFailurePolicy(
        new DefinitiveChannelDeliveryError(
          'Feishu rejected the request (http=400, code=230028)',
        ),
      ),
    ).toEqual({
      retryable: false,
      countsTowardChannelRemoval: false,
    });
  });
});
