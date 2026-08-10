/**
 * macOS Keychain credential sync for host-mode Claude runners.
 *
 * On macOS the Claude Code CLI persists its credentials in the login Keychain
 * under the service name `Claude Code-credentials-<hash>` (hash = first 8 hex
 * chars of sha256(CLAUDE_CONFIG_DIR)) and PREFERS that entry over the
 * `.credentials.json` file in the config dir. HappyClaw rewrites the file on
 * every spawn to follow provider-pool rotation, but once the CLI has seeded a
 * Keychain entry, the file is ignored — every turn silently authenticates as
 * whichever account was seeded first, while the pool's health/bindings/UI keep
 * "rotating". This module keeps the Keychain entry's `claudeAiOauth` field in
 * lockstep with the provider selected for the current spawn.
 *
 * The same Keychain payload also stores MCP OAuth state (`mcpOAuth`), so the
 * entry must never be deleted or replaced wholesale — only the
 * `claudeAiOauth` field is merged in or stripped out.
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';

import { logger } from './logger.js';

const SECURITY_BIN = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 10_000;
/** errSecItemNotFound — "not found" is a normal outcome, not an error. */
const NOT_FOUND_MARKER = 'could not be found';

export interface KeychainClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
}

/**
 * Service name the CLI uses for a non-default CLAUDE_CONFIG_DIR. The dir must
 * be the exact string passed to the runner as CLAUDE_CONFIG_DIR (realpath'd),
 * or the hash will address a different entry.
 */
export function claudeKeychainServiceName(configDir: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(configDir)
    .digest('hex')
    .slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/**
 * Merge the selected account's OAuth credentials into an existing Keychain
 * payload, preserving every other field (mcpOAuth etc).
 *
 * Returns the serialized payload to write, or null when no write is needed
 * (same access token already present, or the existing payload is not JSON —
 * clobbering an unparseable payload risks destroying MCP OAuth state).
 */
export function mergeClaudeKeychainPayload(
  existingJson: string,
  claudeAiOauth: KeychainClaudeAiOauth | null,
): string | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(existingJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const existing = payload.claudeAiOauth as
    | { accessToken?: string }
    | undefined;

  if (claudeAiOauth === null) {
    if (!('claudeAiOauth' in payload)) return null;
    delete payload.claudeAiOauth;
    return JSON.stringify(payload);
  }

  if (existing?.accessToken === claudeAiOauth.accessToken) return null;
  payload.claudeAiOauth = claudeAiOauth;
  return JSON.stringify(payload);
}

function keychainAccount(): string {
  return os.userInfo().username;
}

function readKeychainPayload(service: string): string | null {
  try {
    return execFileSync(
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-a', keychainAccount(), '-w'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SECURITY_TIMEOUT_MS,
      },
    ).trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (!String(stderr).includes(NOT_FOUND_MARKER)) {
      logger.warn(
        { service, err: (err as Error).message },
        'Keychain read failed; skipping credential sync',
      );
    }
    return null;
  }
}

function writeKeychainPayload(service: string, payload: string): boolean {
  try {
    // -w on argv mirrors what the CLI itself does for payloads above the
    // `security -i` stdin limit (it logs "using argv"). The exposure window in
    // the process list is brief and same-user only.
    execFileSync(
      SECURITY_BIN,
      [
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        keychainAccount(),
        '-w',
        payload,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: SECURITY_TIMEOUT_MS },
    );
    return true;
  } catch (err) {
    logger.warn(
      { service, err: (err as Error).message },
      'Keychain write failed; runner may authenticate as a stale account',
    );
    return false;
  }
}

/**
 * Ensure the Keychain entry for this config dir carries the given OAuth
 * credentials. No-op off macOS, when no entry exists yet (the CLI seeds one
 * from .credentials.json on first run), or when the entry already holds the
 * same access token. Best effort — never throws.
 */
export function syncClaudeKeychainOAuth(
  configDir: string,
  claudeAiOauth: KeychainClaudeAiOauth,
): void {
  if (process.platform !== 'darwin') return;
  const service = claudeKeychainServiceName(configDir);
  const existing = readKeychainPayload(service);
  if (existing === null) return;
  const merged = mergeClaudeKeychainPayload(existing, claudeAiOauth);
  if (merged === null) return;
  if (writeKeychainPayload(service, merged)) {
    logger.info(
      { service, configDir },
      'Keychain claudeAiOauth synced to selected provider',
    );
  }
}

/**
 * Strip claudeAiOauth from the Keychain entry (third-party provider turns:
 * leftover OAuth credentials force the CLI onto the OAuth code path even when
 * the .credentials.json file was removed). Preserves MCP OAuth state.
 */
export function removeClaudeKeychainOAuth(configDir: string): void {
  if (process.platform !== 'darwin') return;
  const service = claudeKeychainServiceName(configDir);
  const existing = readKeychainPayload(service);
  if (existing === null) return;
  const merged = mergeClaudeKeychainPayload(existing, null);
  if (merged === null) return;
  if (writeKeychainPayload(service, merged)) {
    logger.info(
      { service, configDir },
      'Keychain claudeAiOauth removed for third-party provider',
    );
  }
}
