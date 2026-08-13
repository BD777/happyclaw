import {
  claimWeChatContextToken,
  deleteWeChatContextToken,
  isDatabaseInitialized,
  listWeChatContextTokens,
  upsertWeChatContextToken,
  type StoredWeChatContextToken,
  type WeChatContextTokenClaimResult,
} from './db.js';

// Tencent does not publish a stable machine-readable contract for these
// limits. The official plugin issue tracker and observed iLink behavior agree
// on a 24-hour window and ten sendmessage calls per inbound refresh. Keep a
// one-hour safety margin because field reports show expiry can occur early.
export const WECHAT_CONTEXT_TOKEN_MAX_AGE_MS = 23 * 60 * 60 * 1000;
export const WECHAT_CONTEXT_TOKEN_MAX_SENDS = 10;

export interface WeChatContextTokenRecord {
  accountId: string;
  userId: string;
  token: string;
  refreshedAtMs: number;
  sendCount: number;
  lastSentAtMs: number | null;
}

export interface WeChatContextTokenClaimInput {
  accountId: string;
  userId: string;
  expectedToken: string;
  expectedRefreshedAtMs: number;
  claimCount: number;
  maxSendCount: number;
  maxAgeMs: number;
  nowMs: number;
}

export interface WeChatContextTokenStore {
  list(accountId: string): WeChatContextTokenRecord[];
  upsert(input: {
    accountId: string;
    userId: string;
    token: string;
    refreshedAtMs: number;
  }): WeChatContextTokenRecord;
  claim(
    input: WeChatContextTokenClaimInput,
  ):
    | { status: 'claimed'; record: WeChatContextTokenRecord }
    | { status: 'missing' | 'changed' | 'expired' | 'quota_exhausted' };
  delete(input: {
    accountId: string;
    userId: string;
    expectedToken?: string;
    expectedRefreshedAtMs?: number;
  }): boolean;
}

export type WeChatContextTokenFailureReason =
  | 'missing'
  | 'expired'
  | 'quota_exhausted';

export class WeChatContextTokenError extends Error {
  readonly code = 'WECHAT_CONTEXT_REFRESH_REQUIRED';

  constructor(
    readonly reason: WeChatContextTokenFailureReason,
    readonly userId: string,
  ) {
    const reasonText =
      reason === 'missing'
        ? '缺少回复凭证'
        : reason === 'expired'
          ? '回复凭证已过期'
          : '本轮 10 条回复额度已用完';
    super(`微信${reasonText}，请让该用户先向机器人发送一条新消息后再重试`);
    this.name = 'WeChatContextTokenError';
  }
}

function fromStored(
  record: StoredWeChatContextToken,
): WeChatContextTokenRecord {
  return {
    accountId: record.channel_account_id,
    userId: record.user_id,
    token: record.context_token,
    refreshedAtMs: record.refreshed_at_ms,
    sendCount: record.send_count,
    lastSentAtMs: record.last_sent_at_ms,
  };
}

function fromClaim(
  result: WeChatContextTokenClaimResult,
): ReturnType<WeChatContextTokenStore['claim']> {
  return result.status === 'claimed'
    ? { status: 'claimed', record: fromStored(result.record) }
    : result;
}

export function createDatabaseWeChatContextTokenStore(): WeChatContextTokenStore | null {
  if (!isDatabaseInitialized()) return null;
  return {
    list: (accountId) => listWeChatContextTokens(accountId).map(fromStored),
    upsert: (input) =>
      fromStored(
        upsertWeChatContextToken({
          channelAccountId: input.accountId,
          userId: input.userId,
          contextToken: input.token,
          refreshedAtMs: input.refreshedAtMs,
        }),
      ),
    claim: (input) =>
      fromClaim(
        claimWeChatContextToken({
          channelAccountId: input.accountId,
          userId: input.userId,
          expectedToken: input.expectedToken,
          expectedRefreshedAtMs: input.expectedRefreshedAtMs,
          claimCount: input.claimCount,
          maxSendCount: input.maxSendCount,
          maxAgeMs: input.maxAgeMs,
          nowMs: input.nowMs,
        }),
      ),
    delete: (input) =>
      deleteWeChatContextToken({
        channelAccountId: input.accountId,
        userId: input.userId,
        expectedToken: input.expectedToken,
        expectedRefreshedAtMs: input.expectedRefreshedAtMs,
      }),
  };
}

export interface WeChatContextTokenManagerOptions {
  accountId?: string;
  store?: WeChatContextTokenStore | null;
  now?: () => number;
  maxAgeMs?: number;
  maxSendCount?: number;
}

/**
 * Connection-local cache backed by an account-scoped durable store. The
 * manager owns lifetime/quota enforcement and compare-and-delete invalidation;
 * transport code only ever receives a token after a successful reservation.
 */
export class WeChatContextTokenManager {
  private readonly cache = new Map<string, WeChatContextTokenRecord>();
  private readonly accountId?: string;
  private readonly store: WeChatContextTokenStore | null;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly maxSendCount: number;

  constructor(options: WeChatContextTokenManagerOptions) {
    this.accountId = options.accountId;
    this.store = options.store ?? null;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? WECHAT_CONTEXT_TOKEN_MAX_AGE_MS;
    this.maxSendCount = options.maxSendCount ?? WECHAT_CONTEXT_TOKEN_MAX_SENDS;
  }

  restore(): number {
    this.cache.clear();
    if (!this.accountId || !this.store) return 0;
    const nowMs = this.now();
    for (const record of this.store.list(this.accountId)) {
      if (nowMs - record.refreshedAtMs >= this.maxAgeMs) {
        this.store.delete({
          accountId: this.accountId,
          userId: record.userId,
          expectedToken: record.token,
          expectedRefreshedAtMs: record.refreshedAtMs,
        });
        continue;
      }
      this.cache.set(record.userId, record);
    }
    return this.cache.size;
  }

  refresh(userId: string, token: string, inboundAtMs: number): void {
    const nowMs = this.now();
    const refreshedAtMs = Math.min(nowMs, Math.max(0, inboundAtMs));
    const record =
      this.accountId && this.store
        ? this.store.upsert({
            accountId: this.accountId,
            userId,
            token,
            refreshedAtMs,
          })
        : {
            accountId: this.accountId ?? '',
            userId,
            token,
            refreshedAtMs,
            sendCount: 0,
            lastSentAtMs: null,
          };
    this.cache.set(userId, record);
  }

  claim(userId: string, claimCount = 1): WeChatContextTokenRecord {
    if (!Number.isInteger(claimCount) || claimCount <= 0) {
      throw new Error('WeChat context_token claimCount must be positive');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = this.cache.get(userId);
      if (!record) throw new WeChatContextTokenError('missing', userId);
      const nowMs = this.now();
      if (nowMs - record.refreshedAtMs >= this.maxAgeMs) {
        this.invalidate(record);
        throw new WeChatContextTokenError('expired', userId);
      }
      if (record.sendCount + claimCount > this.maxSendCount) {
        throw new WeChatContextTokenError('quota_exhausted', userId);
      }

      if (!this.accountId || !this.store) {
        const claimed = {
          ...record,
          sendCount: record.sendCount + claimCount,
          lastSentAtMs: nowMs,
        };
        this.cache.set(userId, claimed);
        return claimed;
      }

      const result = this.store.claim({
        accountId: this.accountId,
        userId,
        expectedToken: record.token,
        expectedRefreshedAtMs: record.refreshedAtMs,
        claimCount,
        maxSendCount: this.maxSendCount,
        maxAgeMs: this.maxAgeMs,
        nowMs,
      });
      if (result.status === 'claimed') {
        this.cache.set(userId, result.record);
        return result.record;
      }
      if (result.status === 'changed') {
        const latest = this.store
          .list(this.accountId)
          .find((candidate) => candidate.userId === userId);
        if (latest) this.cache.set(userId, latest);
        else this.cache.delete(userId);
        continue;
      }
      if (result.status === 'expired') this.invalidate(record);
      throw new WeChatContextTokenError(result.status, userId);
    }
    throw new WeChatContextTokenError('missing', userId);
  }

  peek(userId: string): WeChatContextTokenRecord | undefined {
    const record = this.cache.get(userId);
    if (!record) return undefined;
    if (this.now() - record.refreshedAtMs >= this.maxAgeMs) {
      this.invalidate(record);
      return undefined;
    }
    return record;
  }

  invalidate(record: WeChatContextTokenRecord): boolean {
    const current = this.cache.get(record.userId);
    if (
      !current ||
      current.token !== record.token ||
      current.refreshedAtMs !== record.refreshedAtMs
    ) {
      return false;
    }
    if (this.accountId && this.store) {
      this.store.delete({
        accountId: this.accountId,
        userId: record.userId,
        expectedToken: record.token,
        expectedRefreshedAtMs: record.refreshedAtMs,
      });
    }
    this.cache.delete(record.userId);
    return true;
  }

  clearMemory(): void {
    this.cache.clear();
  }
}
