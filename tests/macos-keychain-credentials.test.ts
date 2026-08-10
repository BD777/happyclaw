import { describe, expect, test } from 'vitest';

import {
  claudeKeychainServiceName,
  mergeClaudeKeychainPayload,
} from '../src/macos-keychain-credentials.js';

const OAUTH = {
  accessToken: 'sk-ant-oat01-new',
  refreshToken: 'sk-ant-ort01-new',
  expiresAt: 1_800_000_000_000,
  scopes: ['user:inference', 'user:profile'],
};

describe('claudeKeychainServiceName', () => {
  test('matches the CLI derivation: first 8 hex of sha256(configDir)', () => {
    // Known vector observed from a live Claude Code 2.1.220 install.
    expect(
      claudeKeychainServiceName(
        '/Users/christianlee/Documents/git/happyclaw/data/sessions/main/.claude',
      ),
    ).toBe('Claude Code-credentials-b74245f7');
  });

  test('different config dirs address different entries', () => {
    expect(claudeKeychainServiceName('/a/.claude')).not.toBe(
      claudeKeychainServiceName('/b/.claude'),
    );
  });
});

describe('mergeClaudeKeychainPayload', () => {
  test('replaces claudeAiOauth while preserving unrelated fields', () => {
    const existing = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-old' },
      mcpOAuth: { 'plugin:x|abc': { serverName: 'x', clientId: 'c1' } },
    });
    const merged = mergeClaudeKeychainPayload(existing, OAUTH);
    expect(merged).not.toBeNull();
    const parsed = JSON.parse(merged!);
    expect(parsed.claudeAiOauth).toEqual(OAUTH);
    expect(parsed.mcpOAuth['plugin:x|abc'].clientId).toBe('c1');
  });

  test('returns null when the same access token is already stored', () => {
    const existing = JSON.stringify({
      claudeAiOauth: { ...OAUTH },
      mcpOAuth: {},
    });
    expect(mergeClaudeKeychainPayload(existing, OAUTH)).toBeNull();
  });

  test('adds claudeAiOauth to a payload that lacks it', () => {
    const existing = JSON.stringify({ mcpOAuth: {} });
    const merged = mergeClaudeKeychainPayload(existing, OAUTH);
    expect(JSON.parse(merged!).claudeAiOauth).toEqual(OAUTH);
  });

  test('null oauth strips claudeAiOauth and keeps the rest', () => {
    const existing = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-old' },
      mcpOAuth: { keep: true },
    });
    const merged = mergeClaudeKeychainPayload(existing, null);
    const parsed = JSON.parse(merged!);
    expect(parsed.claudeAiOauth).toBeUndefined();
    expect(parsed.mcpOAuth.keep).toBe(true);
  });

  test('null oauth on a payload without claudeAiOauth is a no-op', () => {
    expect(
      mergeClaudeKeychainPayload(JSON.stringify({ mcpOAuth: {} }), null),
    ).toBeNull();
  });

  test('never clobbers an unparseable payload', () => {
    expect(mergeClaudeKeychainPayload('not json', OAUTH)).toBeNull();
    expect(mergeClaudeKeychainPayload('[1,2]', OAUTH)).toBeNull();
  });
});
