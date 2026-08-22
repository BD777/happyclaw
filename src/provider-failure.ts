export const PROVIDER_FAILURE_USER_NOTICE =
  '⚠️ 当前模型服务额度已用尽或暂时不可用，本次处理已停止。请稍后重试，或联系管理员切换可用模型。';

/**
 * A liveness stall is not an account verdict, so it must not reuse the quota
 * wording. It is only surfaced after the bounded same-provider retry is spent.
 */
export const PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE =
  '⚠️ 模型服务本轮长时间没有任何响应，重试后仍未恢复，本次请求未被执行。这通常是上游暂时不可用或网络中断，与账号额度无关。请稍后重新发送。';

export interface ProviderFailureHealth {
  profileId: string;
  healthy: boolean;
}

export interface ProviderFailureDisposition {
  /** Another configured provider can replay the same durable input. */
  retryElsewhere: boolean;
  /** The provider pool is exhausted, so the user input must end visibly. */
  terminal: boolean;
}

/**
 * Decide whether an account/provider failure should remain a control-plane
 * retry signal or become a terminal user-visible failure.
 *
 * The failed provider must be quarantined before this function is called.
 */
export function resolveProviderFailureDisposition(
  selectedProfileId: string | null,
  health: ProviderFailureHealth[],
): ProviderFailureDisposition {
  const retryElsewhere =
    selectedProfileId !== null &&
    health.some(
      (candidate) =>
        candidate.profileId !== selectedProfileId && candidate.healthy,
    );
  return {
    retryElsewhere,
    terminal: !retryElsewhere,
  };
}

/** The identity fields a liveness replay budget can be keyed on. */
export interface LivenessRetryIdentity {
  readonly inputTurnId?: string;
  readonly ipcReceipts?: ReadonlyArray<{ cursor: { id: string } }>;
}

/**
 * A replay-stable identity for the input turn behind an output.
 *
 * `inputTurnId` is the IPC deliveryId for a warm turn, and that is a fresh UUID
 * on every hand-off — keying the retry budget on it would reset the budget on
 * each replay and never converge. The durable message id carried by the receipt
 * cursor survives replay, so prefer it. Cold turns already use the message id as
 * their ContainerInput.turnId, so they are stable either way.
 */
export function resolveLivenessRetryKey(
  output: LivenessRetryIdentity,
): string | undefined {
  return output.ipcReceipts?.[0]?.cursor?.id || output.inputTurnId;
}

/** Same-provider replay budget for one liveness stall. */
export const DEFAULT_MAX_LIVENESS_RETRIES = 1;
const DEFAULT_MAX_TRACKED_LIVENESS_TURNS = 512;

/**
 * Bounded same-provider replay budget for liveness stalls, keyed by durable
 * input turn.
 *
 * A stall judged no account, so the right answer is to run the same input
 * again rather than retire it. Each retry is a fresh runner, so the ledger must
 * live in the long-lived host process. It is what stops a permanently wedged
 * upstream from replaying one input forever.
 */
export class LivenessRetryLedger {
  private readonly used = new Map<string, number>();

  constructor(
    private readonly maxRetries: number = DEFAULT_MAX_LIVENESS_RETRIES,
    private readonly maxTracked: number = DEFAULT_MAX_TRACKED_LIVENESS_TURNS,
  ) {}

  /**
   * @returns true when one more same-provider attempt is still allowed.
   *
   * Without a durable turn identity there is nothing to bound a replay with, so
   * this fails closed rather than risk an unbounded loop.
   */
  consume(inputTurnId: string | undefined): boolean {
    if (!inputTurnId) return false;
    const spent = this.used.get(inputTurnId) ?? 0;
    if (spent >= this.maxRetries) {
      this.used.delete(inputTurnId);
      return false;
    }
    // Turns that later succeed never come back to clear their entry, so evict
    // in insertion order instead of leaking one entry per stall.
    if (!this.used.has(inputTurnId) && this.used.size >= this.maxTracked) {
      const oldest = this.used.keys().next().value;
      if (oldest !== undefined) this.used.delete(oldest);
    }
    this.used.set(inputTurnId, spent + 1);
    return true;
  }

  /** Test/diagnostic hook: number of turns currently holding a spent retry. */
  get trackedTurnCount(): number {
    return this.used.size;
  }
}
