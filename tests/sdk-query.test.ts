import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const reconcile = vi.hoisted(() => vi.fn());
const oauth = {
  accessToken: 'configured-access',
  refreshToken: 'configured-refresh',
  expiresAt: 9999999999999,
  scopes: ['user:inference'],
};
vi.mock('../src/docker-oauth-credentials.js', () => ({
  reconcileDockerOAuthCredentials: reconcile,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));
vi.mock('../src/runtime-config.js', () => ({
  buildClaudeEnvLines: () => ['ANTHROPIC_API_KEY=test-key'],
  clearInheritedClaudeProviderEnv: () => {},
  getClaudeProviderConfig: () => ({ anthropicModel: 'test-model' }),
  getEnabledProviders: () => [{ id: 'configured-provider' }],
  providerToConfig: () => ({
    anthropicModel: 'test-model',
    claudeOAuthCredentials: oauth,
  }),
  writeCredentialsFile: (
    dir: string,
    config: { claudeOAuthCredentials: unknown },
  ) => {
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: config.claudeOAuthCredentials }),
      { mode: 0o600 },
    );
  },
}));
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

const { sdkQuery } = await import('../src/sdk-query.js');

function successfulConversation(result: string) {
  return (async function* () {
    yield { type: 'result', subtype: 'success', result };
  })();
}

beforeEach(() => {
  query.mockReset();
  reconcile.mockReset();
});

describe('sdkQuery', () => {
  test('runs one-turn text queries without exposing tools or filesystem settings', async () => {
    query.mockReturnValue(successfulConversation(' generated response '));

    await expect(sdkQuery('generate a profile')).resolves.toBe(
      'generated response',
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toMatchObject({
      prompt: 'generate a profile',
      options: {
        model: 'test-model',
        maxTurns: 2,
        tools: [],
        skills: [],
        settingSources: [],
        allowedTools: [],
      },
    });
  });
});

test('passes the configured full OAuth in an isolated directory and reconciles before cleanup', async () => {
  let dir = '';
  query.mockImplementation(({ options }) => {
    dir = options.env.CLAUDE_CONFIG_DIR;
    expect(dir).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'))
        .claudeAiOauth,
    ).toEqual(oauth);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    return successfulConversation('ok');
  });
  reconcile.mockImplementation((options) => {
    expect(fs.existsSync(options.credentialsFilePath)).toBe(true);
    expect(options.providerId).toBe('configured-provider');
    expect(options.launchCredentials).toEqual(oauth);
  });
  await expect(sdkQuery('probe')).resolves.toBe('ok');
  expect(reconcile).toHaveBeenCalledOnce();
  expect(fs.existsSync(dir)).toBe(false);
});

test('concurrent queries have separate credentials and cleanup on failure', async () => {
  const dirs: string[] = [];
  query.mockImplementation(({ options }) => {
    dirs.push(options.env.CLAUDE_CONFIG_DIR);
    return (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('provider unavailable');
    })();
  });
  await expect(
    Promise.all([sdkQuery('one'), sdkQuery('two')]),
  ).resolves.toEqual([null, null]);
  expect(new Set(dirs).size).toBe(2);
  expect(dirs.every((dir) => !fs.existsSync(dir))).toBe(true);
});
