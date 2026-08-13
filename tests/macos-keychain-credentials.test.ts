import { execFileSync } from 'child_process';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  claudeKeychainServiceName,
  mergeClaudeKeychainPayload,
  removeClaudeKeychainOAuth,
  syncClaudeKeychainOAuth,
} from '../src/macos-keychain-credentials.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

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

describe('platform guard', () => {
  const execFileSyncMock = vi.mocked(execFileSync);
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    execFileSyncMock.mockReset();
  });

  // The Keychain store only exists on macOS; on every other platform the CLI
  // reads .credentials.json directly, which host spawns already rewrite. Both
  // entry points must return without touching the `security` binary — it does
  // not exist off macOS.
  test.each(['linux', 'win32', 'freebsd'])(
    'syncClaudeKeychainOAuth is a no-op on %s',
    (platform) => {
      setPlatform(platform);
      expect(() =>
        syncClaudeKeychainOAuth('/home/user/.claude', OAUTH),
      ).not.toThrow();
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  test.each(['linux', 'win32', 'freebsd'])(
    'removeClaudeKeychainOAuth is a no-op on %s',
    (platform) => {
      setPlatform(platform);
      expect(() =>
        removeClaudeKeychainOAuth('/home/user/.claude'),
      ).not.toThrow();
      expect(execFileSyncMock).not.toHaveBeenCalled();
    },
  );

  // Positive control: proves the no-op assertions above are not passing
  // vacuously (i.e. the mock plumbing does observe real `security` calls).
  test('on darwin, sync reads the entry and writes the merged payload', () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-ant-oat01-old' },
        mcpOAuth: { keep: true },
      }),
    );
    execFileSyncMock.mockReturnValueOnce('');

    syncClaudeKeychainOAuth('/home/user/.claude', OAUTH);

    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const [readArgs, writeArgs] = execFileSyncMock.mock.calls.map(
      (call) => call[1] as string[],
    );
    expect(readArgs).toContain('find-generic-password');
    expect(writeArgs).toContain('add-generic-password');
    const written = JSON.parse(writeArgs[writeArgs.indexOf('-w') + 1]);
    expect(written.claudeAiOauth).toEqual(OAUTH);
    expect(written.mcpOAuth.keep).toBe(true);
  });

  test('on darwin, a missing Keychain entry skips the write', () => {
    setPlatform('darwin');
    execFileSyncMock.mockImplementationOnce(() => {
      const err = new Error('security: exit 44') as Error & {
        stderr: string;
      };
      err.stderr =
        'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
      throw err;
    });

    syncClaudeKeychainOAuth('/home/user/.claude', OAUTH);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});
