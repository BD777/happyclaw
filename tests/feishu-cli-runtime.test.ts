import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  applyFeishuCliBindingToEnvironment,
  applyFeishuCliBindingToEnvLines,
  ensureFeishuCliProfile,
  FeishuCliCredentialBindingError,
  feishuCliProfileName,
  resolveFeishuCliRuntimeBinding,
} from '../src/feishu-cli-runtime.js';
import type { ChannelAccount, ChannelTurnContext } from '../src/types.js';

const temporaryDirectories: string[] = [];

function account(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'account-current',
    owner_user_id: 'owner-1',
    provider: 'feishu',
    name: 'Current Bot',
    secret_ref: 'channel-account:account-current',
    enabled: true,
    is_default: true,
    is_legacy_default: false,
    auth_mode: 'credentials',
    auth_status: 'authorized',
    transport_status: 'connected',
    status: 'connected',
    default_agent_profile_id: null,
    default_workspace_jid: null,
    last_error: null,
    connected_at: null,
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function context(
  overrides: Partial<ChannelTurnContext> = {},
): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: 'account-current',
    sourceJid: 'feishu:chat#account:account-current#root:message',
    bot: { appId: 'cli_current' },
    chat: { id: 'chat' },
    message: { id: 'message' },
    ...overrides,
  };
}

function dependencies(
  current = account(),
  secret: Record<string, string | undefined> | null = {
    appId: 'cli_current',
    appSecret: 'secret-current',
  },
) {
  return {
    getChannelAccount: (id: string) =>
      id === current.id ? current : undefined,
    loadChannelAccountSecret: (secretRef: string) =>
      secretRef === current.secret_ref ? secret : null,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Feishu CLI runtime identity binding', () => {
  test('prefers the exact turn account over global fallback credentials', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        channelContext: context(),
        fallbackEnvironment: {
          FEISHU_APP_ID: 'cli_global',
          FEISHU_APP_SECRET: 'secret-global',
        },
      },
      dependencies(),
    );

    expect(binding).toEqual({
      source: 'channel_account',
      accountId: 'account-current',
      appId: 'cli_current',
      appSecret: 'secret-current',
      profileName: 'happyclaw_account-current',
    });
  });

  test('uses the workspace account when the turn has no Feishu identity', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        workspaceChannelAccountId: 'account-current',
        fallbackEnvironment: {
          FEISHU_APP_ID: 'cli_global',
          FEISHU_APP_SECRET: 'secret-global',
        },
      },
      dependencies(),
    );

    expect(binding?.source).toBe('channel_account');
    expect(binding?.appId).toBe('cli_current');
  });

  test('falls back to process credentials only without a bound account', () => {
    const binding = resolveFeishuCliRuntimeBinding({
      ownerUserId: 'owner-1',
      fallbackEnvironment: {
        FEISHU_APP_ID: 'cli_global',
        FEISHU_APP_SECRET: 'secret-global',
        FEISHU_PROFILE: 'personal',
      },
    });

    expect(binding).toEqual({
      source: 'global_environment',
      accountId: null,
      appId: 'cli_global',
      appSecret: 'secret-global',
      profileName: 'personal',
    });
  });

  test('does not create a partial fallback identity', () => {
    expect(
      resolveFeishuCliRuntimeBinding({
        fallbackEnvironment: { FEISHU_APP_ID: 'cli_global' },
      }),
    ).toBeNull();
  });

  test('rejects control characters in fallback credentials', () => {
    expect(
      resolveFeishuCliRuntimeBinding({
        fallbackEnvironment: {
          FEISHU_APP_ID: 'cli_global\nINJECTED=value',
          FEISHU_APP_SECRET: 'secret-global',
        },
      }),
    ).toBeNull();
  });

  test.each([
    [
      'missing account',
      dependencies(account({ id: 'different' })),
      /no longer exists/,
    ],
    [
      'wrong owner',
      dependencies(account({ owner_user_id: 'owner-2' })),
      /does not belong/,
    ],
    ['disabled account', dependencies(account({ enabled: false })), /disabled/],
    [
      'incomplete secret',
      dependencies(account(), { appId: 'cli_current' }),
      /incomplete credentials/,
    ],
    [
      'stale context app',
      dependencies(account(), {
        appId: 'cli_other',
        appSecret: 'secret-other',
      }),
      /does not match/,
    ],
    [
      'unsafe secret',
      dependencies(account(), {
        appId: 'cli_current',
        appSecret: 'secret-current\nINJECTED=value',
      }),
      /invalid credential characters/,
    ],
  ])('fails closed for an explicitly bound %s', (_name, deps, error) => {
    expect(() =>
      resolveFeishuCliRuntimeBinding(
        {
          ownerUserId: 'owner-1',
          channelContext: context(),
          fallbackEnvironment: {
            FEISHU_APP_ID: 'cli_global',
            FEISHU_APP_SECRET: 'secret-global',
          },
        },
        deps,
      ),
    ).toThrow(error);
  });

  test('replaces lower-priority Feishu values in host and container envs', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        channelContext: context(),
      },
      dependencies(),
    );
    const environment = {
      FEISHU_APP_ID: 'cli_global',
      FEISHU_APP_SECRET: 'secret-global',
      FEISHU_PROFILE: 'global',
      KEEP: 'yes',
    };
    const lines = [
      'FEISHU_APP_ID=cli_workspace',
      'FEISHU_APP_SECRET=secret-workspace',
      'FEISHU_PROFILE=workspace',
      'KEEP=yes',
    ];

    applyFeishuCliBindingToEnvironment(environment, binding);
    applyFeishuCliBindingToEnvLines(lines, binding);

    expect(environment).toEqual({
      FEISHU_APP_ID: 'cli_current',
      FEISHU_APP_SECRET: 'secret-current',
      FEISHU_PROFILE: 'happyclaw_account-current',
      KEEP: 'yes',
    });
    expect(lines).toEqual([
      'KEEP=yes',
      'FEISHU_APP_ID=cli_current',
      'FEISHU_APP_SECRET=secret-current',
      'FEISHU_PROFILE=happyclaw_account-current',
    ]);
  });

  test('creates an account-isolated profile without writing credentials', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-feishu-cli-'),
    );
    temporaryDirectories.push(root);
    const name = feishuCliProfileName('12345678-1234-1234-1234-123456789012');
    const profile = ensureFeishuCliProfile(root, name);

    expect(profile).toBe(path.join(root, 'profiles', name));
    expect(fs.statSync(profile).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(profile)).toEqual([]);
  });

  test('rejects unsafe profile names', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-feishu-cli-'),
    );
    temporaryDirectories.push(root);
    expect(() => ensureFeishuCliProfile(root, '../escape')).toThrow(
      FeishuCliCredentialBindingError,
    );
  });
});
