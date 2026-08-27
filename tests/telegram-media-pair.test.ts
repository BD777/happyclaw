import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  attemptTelegramCaptionPair,
  matchTelegramPairCode,
} from '../src/telegram.js';

describe('matchTelegramPairCode', () => {
  test('reads /pair from text or caption', () => {
    expect(matchTelegramPairCode('/pair ABC123')).toBe('ABC123');
    expect(matchTelegramPairCode('/PAIR xyz')).toBe('xyz');
    expect(matchTelegramPairCode('  /pair code-1  ')).toBe('code-1');
  });

  test('rejects missing or non-pair captions', () => {
    expect(matchTelegramPairCode(undefined)).toBeNull();
    expect(matchTelegramPairCode('')).toBeNull();
    expect(matchTelegramPairCode('hello')).toBeNull();
    expect(matchTelegramPairCode('/start')).toBeNull();
    expect(matchTelegramPairCode('not /pair CODE')).toBeNull();
  });
});

describe('unauthorized photo caption /pair reaches onPairAttempt', () => {
  test('attemptTelegramCaptionPair calls onPairAttempt with the code', async () => {
    const onPairAttempt = vi.fn(async () => true);
    await expect(
      attemptTelegramCaptionPair(
        '/pair ABC123',
        onPairAttempt,
        'telegram:99',
        'Ada',
      ),
    ).resolves.toBe(true);
    expect(onPairAttempt).toHaveBeenCalledWith('telegram:99', 'Ada', 'ABC123');
  });

  test('plain photo caption does not pair', async () => {
    const onPairAttempt = vi.fn(async () => true);
    await expect(
      attemptTelegramCaptionPair(
        'just a photo',
        onPairAttempt,
        'telegram:99',
        'Ada',
      ),
    ).resolves.toBeNull();
    expect(onPairAttempt).not.toHaveBeenCalled();
  });
});

describe('Telegram photo/document pairing leftover', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/telegram.ts'),
    'utf8',
  );

  test('photo and document unauthorized paths call attemptTelegramCaptionPair', () => {
    const photoAt = source.indexOf("bot.on('message:photo'");
    const docAt = source.indexOf("bot.on('message:document'");
    const memberAt = source.indexOf("bot.on('my_chat_member'");
    expect(photoAt).toBeGreaterThan(-1);
    expect(docAt).toBeGreaterThan(photoAt);
    expect(memberAt).toBeGreaterThan(docAt);
    const photoBlock = source.slice(photoAt, docAt);
    const docBlock = source.slice(docAt, memberAt);
    expect(photoBlock).toContain('attemptTelegramCaptionPair');
    expect(docBlock).toContain('attemptTelegramCaptionPair');
    expect(photoBlock).toContain('This chat is not yet paired');
    expect(docBlock).toContain('This chat is not yet paired');
  });
});
