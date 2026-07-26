import fs from 'node:fs';
import path from 'node:path';

import { loadChannelAccountSecret } from './channel-account-secrets.js';
import { getChannelAccount } from './db.js';
import type { ChannelAccount, ChannelTurnContext } from './types.js';

const FEISHU_CLI_MANAGED_ENV_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_PROFILE',
] as const;

export class FeishuCliCredentialBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuCliCredentialBindingError';
  }
}

export interface FeishuCliRuntimeBinding {
  source: 'channel_account' | 'global_environment';
  accountId: string | null;
  appId: string;
  appSecret: string;
  profileName?: string;
}

interface FeishuCliBindingDependencies {
  getChannelAccount: (id: string) => ChannelAccount | undefined;
  loadChannelAccountSecret: (
    secretRef: string,
  ) => Record<string, string | undefined> | null;
}

export interface ResolveFeishuCliRuntimeBindingInput {
  ownerUserId?: string | null;
  channelContext?: ChannelTurnContext;
  workspaceChannelAccountId?: string | null;
  fallbackEnvironment?: Record<string, string | undefined>;
}

function optionalTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasUnsafeCredentialCharacters(value: string): boolean {
  return /[\u0000\r\n]/.test(value);
}

function fallbackBinding(
  environment: Record<string, string | undefined>,
): FeishuCliRuntimeBinding | null {
  const appId = optionalTrimmed(environment.FEISHU_APP_ID);
  const appSecret = optionalTrimmed(environment.FEISHU_APP_SECRET);
  if (!appId || !appSecret) return null;
  if (
    hasUnsafeCredentialCharacters(appId) ||
    hasUnsafeCredentialCharacters(appSecret)
  ) {
    return null;
  }
  const profileName = optionalTrimmed(environment.FEISHU_PROFILE);
  return {
    source: 'global_environment',
    accountId: null,
    appId,
    appSecret,
    ...(profileName ? { profileName } : {}),
  };
}

export function feishuCliProfileName(accountId: string): string {
  const safeAccountId = accountId.replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `happyclaw_${safeAccountId}`.slice(0, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new FeishuCliCredentialBindingError(
      'The bound Feishu account cannot be represented as a CLI profile',
    );
  }
  return name;
}

/**
 * Resolve the Feishu CLI identity for one Agent run.
 *
 * An exact inbound Feishu turn is authoritative. A workspace-level account is
 * used only when no turn-scoped account exists. The process environment (for
 * example values loaded from ~/.zshrc) is the final compatibility fallback.
 *
 * Once a Feishu account is explicitly bound, failures are closed rather than
 * silently falling back to a different Bot identity.
 */
export function resolveFeishuCliRuntimeBinding(
  input: ResolveFeishuCliRuntimeBindingInput,
  dependencies: FeishuCliBindingDependencies = {
    getChannelAccount,
    loadChannelAccountSecret,
  },
): FeishuCliRuntimeBinding | null {
  const fallbackEnvironment = input.fallbackEnvironment ?? process.env;
  const isFeishuTurn = input.channelContext?.provider === 'feishu';
  const turnAccountId = isFeishuTurn
    ? optionalTrimmed(input.channelContext?.channelAccountId)
    : null;
  const workspaceAccountId = optionalTrimmed(input.workspaceChannelAccountId);
  const candidateAccountId = turnAccountId ?? workspaceAccountId;

  if (!candidateAccountId) {
    return fallbackBinding(fallbackEnvironment);
  }

  const account = dependencies.getChannelAccount(candidateAccountId);
  if (!account) {
    if (!turnAccountId) return fallbackBinding(fallbackEnvironment);
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this turn no longer exists',
    );
  }
  if (account.provider !== 'feishu') {
    if (!turnAccountId) return fallbackBinding(fallbackEnvironment);
    throw new FeishuCliCredentialBindingError(
      'The channel account bound to this Feishu turn has the wrong provider',
    );
  }
  if (!input.ownerUserId || account.owner_user_id !== input.ownerUserId) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run does not belong to the workspace owner',
    );
  }
  if (!account.enabled) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run is disabled',
    );
  }

  const secret = dependencies.loadChannelAccountSecret(account.secret_ref);
  const appId = optionalTrimmed(secret?.appId);
  const appSecret = optionalTrimmed(secret?.appSecret);
  if (!appId || !appSecret) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run has incomplete credentials',
    );
  }
  if (
    hasUnsafeCredentialCharacters(appId) ||
    hasUnsafeCredentialCharacters(appSecret)
  ) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu account bound to this run has invalid credential characters',
    );
  }

  const contextAppId = optionalTrimmed(input.channelContext?.bot?.appId);
  if (turnAccountId && contextAppId && contextAppId !== appId) {
    throw new FeishuCliCredentialBindingError(
      'The Feishu Bot identity for this turn does not match the bound account',
    );
  }

  return {
    source: 'channel_account',
    accountId: account.id,
    appId,
    appSecret,
    profileName: feishuCliProfileName(account.id),
  };
}

export function ensureFeishuCliProfile(
  profileRoot: string,
  profileName: string,
): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profileName)) {
    throw new FeishuCliCredentialBindingError(
      'Invalid Feishu CLI profile name',
    );
  }
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileRoot, 0o700);
  const profilesDir = path.join(profileRoot, 'profiles');
  const profileDir = path.join(profilesDir, profileName);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o700);
  fs.chmodSync(profileDir, 0o700);
  return profileDir;
}

export function prepareFeishuCliRuntimeBinding(
  input: ResolveFeishuCliRuntimeBindingInput & {
    profileRoot?: string | null;
  },
  dependencies?: FeishuCliBindingDependencies,
): FeishuCliRuntimeBinding | null {
  const binding = resolveFeishuCliRuntimeBinding(input, dependencies);
  if (binding?.source === 'channel_account') {
    if (!input.profileRoot || !binding.profileName) {
      throw new FeishuCliCredentialBindingError(
        'A bound Feishu account requires an isolated CLI profile directory',
      );
    }
    ensureFeishuCliProfile(input.profileRoot, binding.profileName);
  }
  return binding;
}

function bindingEnvironment(
  binding: FeishuCliRuntimeBinding,
): Record<string, string> {
  return {
    FEISHU_APP_ID: binding.appId,
    FEISHU_APP_SECRET: binding.appSecret,
    ...(binding.profileName ? { FEISHU_PROFILE: binding.profileName } : {}),
  };
}

export function applyFeishuCliBindingToEnvironment(
  environment: Record<string, string>,
  binding: FeishuCliRuntimeBinding | null,
): void {
  if (!binding) return;
  for (const key of FEISHU_CLI_MANAGED_ENV_KEYS) delete environment[key];
  Object.assign(environment, bindingEnvironment(binding));
}

export function applyFeishuCliBindingToEnvLines(
  lines: string[],
  binding: FeishuCliRuntimeBinding | null,
): void {
  if (!binding) return;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      FEISHU_CLI_MANAGED_ENV_KEYS.some((key) =>
        lines[index]?.startsWith(`${key}=`),
      )
    ) {
      lines.splice(index, 1);
    }
  }
  for (const [key, value] of Object.entries(bindingEnvironment(binding))) {
    lines.push(`${key}=${value}`);
  }
}
