import { loadChannelAccountSecret } from './channel-account-secrets.js';
import { getChannelAccount } from './db.js';
import type { ChannelAccount, ChannelTurnContext } from './types.js';

const FEISHU_CLI_CREDENTIAL_ENV_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
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
  /** Inherited user preference only; HappyClaw never synthesizes a profile. */
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

/**
 * Resolve the Feishu CLI identity for one Agent run.
 *
 * An exact inbound Feishu turn is authoritative. A workspace-level account is
 * used only when no turn-scoped account exists. The inherited process
 * environment is the next fallback regardless of whether it came from zsh,
 * bash, fish, launchd, systemd, Docker, or another launcher. With no complete
 * inherited credentials this returns null and feishu-cli resolves its native
 * active profile or config.yaml without HappyClaw parsing either one.
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
  };
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
  for (const key of FEISHU_CLI_CREDENTIAL_ENV_KEYS) delete environment[key];
  if (binding.profileName) delete environment.FEISHU_PROFILE;
  Object.assign(environment, bindingEnvironment(binding));
}

export function applyFeishuCliBindingToEnvLines(
  lines: string[],
  binding: FeishuCliRuntimeBinding | null,
): void {
  if (!binding) return;
  const managedKeys = binding.profileName
    ? [...FEISHU_CLI_CREDENTIAL_ENV_KEYS, 'FEISHU_PROFILE']
    : FEISHU_CLI_CREDENTIAL_ENV_KEYS;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (managedKeys.some((key) => lines[index]?.startsWith(`${key}=`))) {
      lines.splice(index, 1);
    }
  }
  for (const [key, value] of Object.entries(bindingEnvironment(binding))) {
    lines.push(`${key}=${value}`);
  }
}
