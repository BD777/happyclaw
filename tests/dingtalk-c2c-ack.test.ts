import { describe, expect, test } from 'vitest';

import {
  DingTalkBatchRecipientError,
  parseDingTalkBatchSendResponse,
  parseDingTalkSessionWebhookResponse,
} from '../src/dingtalk.js';

describe('DingTalk outbound strict ACK envelopes', () => {
  test.each(['', '<html>ok</html>', '{broken', '{}'])(
    'rejects malformed or unknown session webhook response %j',
    (body) => {
      expect(() => parseDingTalkSessionWebhookResponse(200, body)).toThrow();
    },
  );

  test('session webhook accepts only errcode=0, not a batch processQueryKey', () => {
    expect(
      parseDingTalkSessionWebhookResponse(
        200,
        JSON.stringify({ errcode: 0, errmsg: 'ok' }),
      ),
    ).toEqual({ errcode: 0, errmsg: 'ok' });
    expect(() =>
      parseDingTalkSessionWebhookResponse(
        200,
        JSON.stringify({ processQueryKey: 'query-1' }),
      ),
    ).toThrow('unrecognized success envelope');
  });

  test('batchSend requires a process key and no rejected recipients', () => {
    const response = {
      processQueryKey: 'query-c2c-1',
      invalidStaffIdList: [],
      flowControlledStaffIdList: [],
    };
    expect(
      parseDingTalkBatchSendResponse(200, JSON.stringify(response)),
    ).toEqual(response);
    expect(() =>
      parseDingTalkBatchSendResponse(
        200,
        JSON.stringify({ errcode: 0, errmsg: 'ok' }),
      ),
    ).toThrow('unrecognized success envelope');
  });

  test.each([
    {
      classification: 'permanent',
      invalidStaffIdList: ['invalid-user'],
      flowControlledStaffIdList: [],
    },
    {
      classification: 'rate_limited',
      invalidStaffIdList: [],
      flowControlledStaffIdList: ['limited-user'],
    },
    {
      classification: 'mixed',
      invalidStaffIdList: ['invalid-user'],
      flowControlledStaffIdList: ['limited-user'],
    },
  ])('classifies recipient failure as $classification', (failure) => {
    try {
      parseDingTalkBatchSendResponse(
        200,
        JSON.stringify({ processQueryKey: 'query', ...failure }),
      );
      throw new Error('expected parser to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(DingTalkBatchRecipientError);
      expect((error as DingTalkBatchRecipientError).classification).toBe(
        failure.classification,
      );
      expect((error as DingTalkBatchRecipientError).invalidStaffIds).toEqual(
        failure.invalidStaffIdList,
      );
      expect(
        (error as DingTalkBatchRecipientError).flowControlledStaffIds,
      ).toEqual(failure.flowControlledStaffIdList);
    }
  });

  test('both parsers reject HTTP and provider failures', () => {
    expect(() =>
      parseDingTalkBatchSendResponse(
        503,
        JSON.stringify({ processQueryKey: 'query' }),
      ),
    ).toThrow('HTTP failed (503)');
    expect(() =>
      parseDingTalkSessionWebhookResponse(
        200,
        JSON.stringify({ errcode: 88, errmsg: 'forbidden' }),
      ),
    ).toThrow('88');
  });
});
