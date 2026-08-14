import { describe, expect, test, vi } from 'vitest';

import {
  FEISHU_FORWARD_COMPANION_MAX_GAP_MS,
  FeishuForwardBundleResolver,
  TransientFeishuForwardLookupError,
  hasAuthoredFeishuText,
  type FeishuForwardCandidate,
} from '../src/feishu-forward-bundle.js';

function root(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_forward',
    messageType: 'merge_forward',
    content: 'Merged and Forwarded Message',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

function note(
  overrides: Partial<FeishuForwardCandidate> = {},
): FeishuForwardCandidate {
  return {
    messageId: 'om_note',
    messageType: 'text',
    content: JSON.stringify({ text: '请分析这些内容' }),
    rootId: 'om_forward',
    parentId: 'om_forward',
    senderOpenId: 'ou_sender',
    createTimeMs: 1_700_000_009_000,
    ...overrides,
  };
}

function lookupResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: {
      items: [
        {
          message_id: 'om_forward',
          msg_type: 'merge_forward',
          create_time: '1700000000000',
          sender: { id: 'ou_sender' },
          ...overrides,
        },
      ],
    },
  };
}

describe('Feishu merged-forward companion detection', () => {
  test('links a cached root and its direct textual note without requiring thread_id', async () => {
    const lookup = vi.fn();
    const resolver = new FeishuForwardBundleResolver(lookup);

    expect(resolver.observeRoot(root())).toEqual({
      kind: 'forward_bundle',
      bundleId: 'om_forward',
      role: 'forwarded_content',
    });
    await expect(resolver.resolveCompanion(note())).resolves.toEqual({
      kind: 'forward_bundle',
      bundleId: 'om_forward',
      role: 'forwarder_comment',
      relatedMessageId: 'om_forward',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('supports note-first event order through one provider lookup', async () => {
    const lookup = vi.fn().mockResolvedValue(lookupResponse());
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toMatchObject({
      bundleId: 'om_forward',
      role: 'forwarder_comment',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('om_forward');
  });

  test('collapses concurrent note-first probes for the same root', async () => {
    const lookup = vi.fn().mockResolvedValue(lookupResponse());
    const resolver = new FeishuForwardBundleResolver(lookup);

    const results = await Promise.all([
      resolver.resolveCompanion(note({ messageId: 'om_note_1' })),
      resolver.resolveCompanion(note({ messageId: 'om_note_2' })),
    ]);
    expect(results.every((result) => result?.bundleId === 'om_forward')).toBe(
      true,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('normalizes a seconds-based root timestamp returned by message.get', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue(lookupResponse({ create_time: '1700000000' }));
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toMatchObject({
      bundleId: 'om_forward',
      role: 'forwarder_comment',
    });
  });

  test('bounds a hung note-first lookup and leaves it retryable', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(() => new Promise<unknown>(() => undefined));
      const resolver = new FeishuForwardBundleResolver(lookup);
      const first = resolver.resolveCompanion(note());
      const firstRejection = expect(first).rejects.toBeInstanceOf(
        TransientFeishuForwardLookupError,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await firstRejection;

      const second = resolver.resolveCompanion(note());
      const secondRejection = expect(second).rejects.toBeInstanceOf(
        TransientFeishuForwardLookupError,
      );
      expect(lookup).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await secondRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test('lets a concurrently arriving real root replace an empty lookup', async () => {
    let finishLookup!: (value: unknown) => void;
    const lookup = vi.fn(
      () => new Promise<unknown>((resolve) => (finishLookup = resolve)),
    );
    const resolver = new FeishuForwardBundleResolver(lookup);

    const pending = resolver.resolveCompanion(note());
    await Promise.resolve();
    resolver.observeRoot(root());
    finishLookup({ data: { items: [] } });

    await expect(pending).resolves.toMatchObject({
      bundleId: 'om_forward',
      role: 'forwarder_comment',
    });
  });

  test('requires same sender, direct parent, compatible thread and a 60s window', async () => {
    const resolver = new FeishuForwardBundleResolver(vi.fn());
    resolver.observeRoot(root({ threadId: 'omt_a' }));

    await expect(
      resolver.resolveCompanion(note({ senderOpenId: 'ou_other' })),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(note({ parentId: 'om_middle' })),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(note({ threadId: 'omt_b' })),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(
        note({
          createTimeMs:
            1_700_000_000_000 + FEISHU_FORWARD_COMPANION_MAX_GAP_MS + 1,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveCompanion(note({ createTimeMs: 1_699_999_999_999 })),
    ).resolves.toBeUndefined();
  });

  test('negative-caches only definitive non-forward roots', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(lookupResponse({ msg_type: 'text' }))
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockRejectedValueOnce(new Error('temporary failure'));
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);

    const transient = new FeishuForwardBundleResolver(lookup);
    await expect(transient.resolveCompanion(note())).rejects.toBeInstanceOf(
      TransientFeishuForwardLookupError,
    );
    await expect(transient.resolveCompanion(note())).rejects.toBeInstanceOf(
      TransientFeishuForwardLookupError,
    );
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  test('does not mistake a returned child for a missing root', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(
        lookupResponse({
          message_id: 'om_child',
          msg_type: 'text',
        }),
      )
      .mockResolvedValueOnce(lookupResponse());
    const resolver = new FeishuForwardBundleResolver(lookup);

    await expect(resolver.resolveCompanion(note())).resolves.toBeUndefined();
    await expect(resolver.resolveCompanion(note())).resolves.toMatchObject({
      bundleId: 'om_forward',
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('uses original text/post structure instead of media placeholders', () => {
    expect(
      hasAuthoredFeishuText('text', JSON.stringify({ text: '说明' })),
    ).toBe(true);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({
          post: {
            zh_cn: {
              content: [[{ tag: 'text', text: '补充说明' }]],
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({ zh_cn: { title: '补充标题', content: [] } }),
      ),
    ).toBe(true);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({ content: [[{ tag: 'img', image_key: 'img_1' }]] }),
      ),
    ).toBe(false);
    expect(
      hasAuthoredFeishuText(
        'post',
        JSON.stringify({
          content: [[{ tag: 'img', image_key: 'img_1' }]],
          metadata: { title: '图片元数据，不是用户文字' },
        }),
      ),
    ).toBe(false);
    expect(
      hasAuthoredFeishuText(
        'image',
        JSON.stringify({ image_key: 'img_1', text: '[图片]' }),
      ),
    ).toBe(false);
  });
});
