import { describe, expect, test } from 'vitest';

import {
  acknowledgeIpcReplyTurn,
  isGenuineReplyResult,
  setIpcReplyInputTurn,
  shouldSkipRetryAfterLateError,
  wasGenuineReplyDeliveredForInput,
} from '../src/reply-delivery.js';

describe('isGenuineReplyResult', () => {
  test('a normal completed SDK final result is genuine', () => {
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(true);
  });

  test('a healthy hold-sequence closure (holdReason now null) is genuine', () => {
    // wasInHeldSeq was true, this result is the merged full content finally
    // delivered as one message — must count as genuine.
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(true);
  });

  test('bg_tasks hold is NOT genuine — background tasks still settling', () => {
    expect(
      isGenuineReplyResult({
        holdReason: 'bg_tasks',
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('truncated hold is NOT genuine — upstream cutoff, auto-continuing', () => {
    expect(
      isGenuineReplyResult({
        holdReason: 'truncated',
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('overflow_partial sourceKind is NOT genuine even with holdReason null', () => {
    // Regression case: runEnded forces holdReason to null unconditionally,
    // so holdReason alone cannot be trusted to catch every partial result.
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'overflow_partial',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('compact_partial sourceKind is NOT genuine even with holdReason null', () => {
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'compact_partial',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('finalizationReason truncated is NOT genuine even with holdReason null', () => {
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'sdk_final',
        finalizationReason: 'truncated',
      }),
    ).toBe(false);
  });
});

describe('shouldSkipRetryAfterLateError', () => {
  test('skips retry when a genuine reply was delivered this run', () => {
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: true,
        ipcReplyDeliveredForInputTurn: false,
      }),
    ).toBe(true);
  });

  test('skips retry when send_message was host-acknowledged for this exact input turn', () => {
    // The exact "runner replies via send_message then errors on a late-turn
    // timeout" scenario — genuineReplyDelivered stays false since no SDK
    // final result ever completed, but a real message was already sent.
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: false,
        ipcReplyDeliveredForInputTurn: true,
      }),
    ).toBe(true);
  });

  test('does NOT skip retry without a final reply or exact-turn host acknowledgement', () => {
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: false,
        ipcReplyDeliveredForInputTurn: false,
      }),
    ).toBe(false);
  });
});

describe('IPC reply turn correlation', () => {
  test("regression: A's late SDK final cannot make active B skip retry", () => {
    const genuineReplyDeliveredByInput = new Map<string, boolean>([
      ['delivery-a', false],
    ]);
    genuineReplyDeliveredByInput.set('delivery-b', false);

    // B is already active when the delayed SDK callback for A is delivered.
    genuineReplyDeliveredByInput.set('delivery-a', true);

    expect(
      wasGenuineReplyDeliveredForInput(
        genuineReplyDeliveredByInput,
        'delivery-a',
      ),
    ).toBe(true);
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: wasGenuineReplyDeliveredForInput(
          genuineReplyDeliveredByInput,
          'delivery-b',
        ),
        ipcReplyDeliveredForInputTurn: false,
      }),
    ).toBe(false);
  });

  test("regression: an older turn's delivery on the same warm runner cannot suppress the current turn's retry", () => {
    const tracker = { inputTurnId: 'delivery-old', delivered: false };
    expect(acknowledgeIpcReplyTurn(tracker, 'delivery-old')).toBe(true);
    expect(tracker.delivered).toBe(true);

    setIpcReplyInputTurn(tracker, 'delivery-current');
    expect(tracker.delivered).toBe(false);
    expect(acknowledgeIpcReplyTurn(tracker, 'delivery-old')).toBe(false);
    expect(tracker.delivered).toBe(false);

    const skipCurrent = shouldSkipRetryAfterLateError({
      genuineReplyDelivered: false,
      ipcReplyDeliveredForInputTurn: tracker.delivered,
    });
    expect(skipCurrent).toBe(false);

    expect(acknowledgeIpcReplyTurn(tracker, 'delivery-current')).toBe(true);
    const skipAcknowledgedCurrent = shouldSkipRetryAfterLateError({
      genuineReplyDelivered: false,
      ipcReplyDeliveredForInputTurn: tracker.delivered,
    });
    expect(skipAcknowledgedCurrent).toBe(true);
  });
});
