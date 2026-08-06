import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

import { isStreamingSessionSettled } from '../src/im-channel.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';

// Regression coverage for issue #629: a freshly-created Feishu streaming
// session sits in 'idle' (card reserved, provider creation deferred to the
// first stream event). The main-runner rotation guard used a bare
// `!isActive()` check, which matched 'idle' too — the session was discarded
// on the very first stream event, beginCreation() never ran, and the durable
// reservation stayed at status=creating until restart recovery fenced it.

describe('isStreamingSessionSettled', () => {
  test('a fresh Feishu controller is idle, inactive, and NOT settled', () => {
    const controller = new StreamingCardController({
      client: {} as any,
      chatId: 'oc_idle_guard',
    });
    expect(controller.currentState).toBe('idle');
    expect(controller.isActive()).toBe(false);
    expect(isStreamingSessionSettled(controller)).toBe(false);
    controller.dispose();
  });

  test('an active session is not settled', () => {
    const session = {
      isActive: () => true,
      currentState: 'streaming',
    };
    expect(isStreamingSessionSettled(session as any)).toBe(false);
  });

  test('a terminal Feishu session is settled and may rotate out', () => {
    for (const currentState of ['completed', 'aborted', 'error']) {
      const session = { isActive: () => false, currentState };
      expect(isStreamingSessionSettled(session as any)).toBe(true);
    }
  });

  test('controllers without a currentState accessor keep prior semantics', () => {
    // DingTalk / Discord / QQ controllers report 'idle' as active inside
    // isActive() itself, so an inactive session there is genuinely terminal.
    const session = { isActive: () => false };
    expect(isStreamingSessionSettled(session as any)).toBe(true);
  });
});

describe('main-runner rotation guards use the settled predicate', () => {
  const main = fs.readFileSync('src/index.ts', 'utf8');

  test('stream-event rotation never discards an idle lazily-created session', () => {
    expect(main).toMatch(
      /streamingSession &&\s*isStreamingSessionSettled\(streamingSession\) &&\s*!sessionErrored &&\s*!runEnded/,
    );
    expect(main).not.toMatch(
      /streamingSession &&\s*!streamingSession\.isActive\(\) &&\s*!sessionErrored &&\s*!runEnded/,
    );
  });

  test('new-message rotation keeps the idle session for the next turn', () => {
    expect(main).not.toMatch(
      /if \(streamingSession && !streamingSession\.isActive\(\)\) \{\s*streamingSession\.dispose\(\);/,
    );
    expect(main).toMatch(
      /if \(streamingSession && isStreamingSessionSettled\(streamingSession\)\) \{\s*streamingSession\.dispose\(\);/,
    );
  });
});
