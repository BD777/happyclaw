import { describe, expect, test } from 'vitest';

import {
  createPassiveReplyStore,
  PASSIVE_REPLY_MAX_USES,
  PASSIVE_REPLY_TTL_MS,
} from '../src/qq-passive-reply.js';

const T0 = 1_700_000_000_000;

describe('createPassiveReplyStore', () => {
  test('returns nothing for an unknown chat', () => {
    const store = createPassiveReplyStore();
    expect(store.claim('c2c:u1', T0)).toBeUndefined();
  });

  test('claims the recorded msg_id and numbers seq from 1', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    expect(store.claim('c2c:u1', T0)).toEqual({ msgId: 'm1', msgSeq: 1 });
    expect(store.claim('c2c:u1', T0)).toEqual({ msgId: 'm1', msgSeq: 2 });
  });

  test('stops handing out a msg_id once its budget is spent', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    for (let i = 1; i <= PASSIVE_REPLY_MAX_USES; i++) {
      expect(store.claim('c2c:u1', T0)).toEqual({ msgId: 'm1', msgSeq: i });
    }

    // Budget exhausted → caller must fall back to an active push.
    expect(store.claim('c2c:u1', T0)).toBeUndefined();
  });

  test('stops handing out a msg_id once the window closes', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);

    expect(store.claim('c2c:u1', T0 + PASSIVE_REPLY_TTL_MS - 1)).toEqual({
      msgId: 'm1',
      msgSeq: 1,
    });
    expect(store.claim('c2c:u1', T0 + PASSIVE_REPLY_TTL_MS)).toBeUndefined();
  });

  test('prefers the freshest reference', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.record('c2c:u1', 'm2', T0 + 1_000);

    expect(store.claim('c2c:u1', T0 + 1_000)?.msgId).toBe('m2');
  });

  test('falls back to an older reference when the newest is exhausted', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.record('c2c:u1', 'm2', T0 + 1_000);

    for (let i = 0; i < PASSIVE_REPLY_MAX_USES; i++) {
      expect(store.claim('c2c:u1', T0 + 1_000)?.msgId).toBe('m2');
    }
    // m2 is spent but m1 is still inside its window.
    expect(store.claim('c2c:u1', T0 + 1_000)).toEqual({
      msgId: 'm1',
      msgSeq: 1,
    });
  });

  test('skips an expired newer reference to reach a live older one', () => {
    // Only reachable because a redelivered event refreshes an entry in place,
    // which breaks the by-age ordering of the list.
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.record('c2c:u1', 'm2', T0);
    // m1 is redelivered much later, so it outlives m2 while staying at the
    // older position in the list.
    store.record('c2c:u1', 'm1', T0 + PASSIVE_REPLY_TTL_MS - 1);

    // At this instant m2 (recorded at T0) has expired but m1 has 1ms left, so
    // the scan has to look past the newer entry instead of stopping at it.
    const claim = store.claim('c2c:u1', T0 + PASSIVE_REPLY_TTL_MS);
    expect(claim?.msgId).toBe('m1');
  });

  test('re-recording the same msg_id refreshes it without resetting budget', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.claim('c2c:u1', T0);

    // Same event redelivered: the window restarts, the platform budget does not.
    store.record('c2c:u1', 'm1', T0 + 1_000);
    expect(store.claim('c2c:u1', T0 + 1_000)).toEqual({
      msgId: 'm1',
      msgSeq: 2,
    });
  });

  test('keeps chats isolated from each other', () => {
    const store = createPassiveReplyStore();
    store.record('c2c:u1', 'm1', T0);
    store.record('group:g1', 'm2', T0);

    expect(store.claim('c2c:u1', T0)?.msgId).toBe('m1');
    expect(store.claim('group:g1', T0)?.msgId).toBe('m2');
  });

  test('drops the oldest reference past maxPerChat', () => {
    const store = createPassiveReplyStore({ maxPerChat: 2 });
    store.record('c1', 'm1', T0);
    store.record('c1', 'm2', T0);
    store.record('c1', 'm3', T0);

    // m1 was evicted; m3 and m2 remain and are consumed newest-first.
    const seen = new Set<string>();
    for (let i = 0; i < 2 * PASSIVE_REPLY_MAX_USES; i++) {
      const claim = store.claim('c1', T0);
      if (claim) seen.add(claim.msgId);
    }
    expect(seen).toEqual(new Set(['m2', 'm3']));
  });

  test('evicts the least recently used chat past maxChats', () => {
    const store = createPassiveReplyStore({ maxChats: 2 });
    store.record('c1', 'm1', T0);
    store.record('c2', 'm2', T0);
    store.record('c3', 'm3', T0);

    expect(store.size()).toBe(2);
    expect(store.claim('c1', T0)).toBeUndefined();
    expect(store.claim('c2', T0)?.msgId).toBe('m2');
    expect(store.claim('c3', T0)?.msgId).toBe('m3');
  });

  test('claiming counts as use for LRU ordering', () => {
    const store = createPassiveReplyStore({ maxChats: 2 });
    store.record('c1', 'm1', T0);
    store.record('c2', 'm2', T0);
    store.claim('c1', T0); // c1 becomes most recently used
    store.record('c3', 'm3', T0); // evicts c2, not c1

    expect(store.claim('c1', T0)?.msgId).toBe('m1');
    expect(store.claim('c2', T0)).toBeUndefined();
  });

  test('ignores empty keys and ids', () => {
    const store = createPassiveReplyStore();
    store.record('', 'm1', T0);
    store.record('c1', '', T0);

    expect(store.size()).toBe(0);
    expect(store.claim('c1', T0)).toBeUndefined();
  });

  test('clear drops everything', () => {
    const store = createPassiveReplyStore();
    store.record('c1', 'm1', T0);
    store.clear();

    expect(store.size()).toBe(0);
    expect(store.claim('c1', T0)).toBeUndefined();
  });
});
