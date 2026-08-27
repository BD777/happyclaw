import { describe, expect, test } from 'vitest';
import {
  isDefinitiveQQPassiveReplyRejection,
  QQApiError,
  validateQQGatewayUrl,
} from '../src/qq.js';

describe('QQ protocol safety', () => {
  test('accepts official secure gateway hosts', () => {
    expect(validateQQGatewayUrl('wss://api.sgroup.qq.com/websocket')).toBe(
      'wss://api.sgroup.qq.com/websocket',
    );
  });

  test.each([
    'ws://api.sgroup.qq.com/websocket',
    'wss://evil.example/websocket',
    'wss://qq.com.evil.example/websocket',
    'wss://user:pass@api.sgroup.qq.com/websocket',
  ])('rejects an untrusted gateway URL: %s', (url) => {
    expect(() => validateQQGatewayUrl(url)).toThrow(/untrusted/);
  });
});

describe('QQ passive fallback evidence', () => {
  test('only an explicit HTTP 400 is safe to retry without msg_id', () => {
    expect(
      isDefinitiveQQPassiveReplyRejection(
        new QQApiError('bad passive reference', 40034025, 400),
      ),
    ).toBe(true);
    expect(
      isDefinitiveQQPassiveReplyRejection(
        new QQApiError('server error', undefined, 500),
      ),
    ).toBe(false);
    expect(
      isDefinitiveQQPassiveReplyRejection(
        new Error('socket timed out after write'),
      ),
    ).toBe(false);
  });
});
