export class SdkControlTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'SdkControlTimeoutError';
  }
}

/**
 * SDK control requests are diagnostic helpers, not part of the model stream.
 * They must never block consumption of assistant/rate-limit/result messages.
 */
export async function runSdkControlWithTimeout<T>(
  operation: string,
  request: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SdkControlTimeoutError(operation, timeoutMs)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const FIRST_RESPONSE_MESSAGE_TYPES = new Set([
  'assistant',
  'result',
  'stream_event',
]);

export type SdkFirstResponseWatchdogPhase =
  | 'first_response'
  | 'api_retry'
  | 'api_retry_limit'
  | 'compaction';

/**
 * Last-resort guard for third-party CLI/provider combinations that persist an
 * API error to the transcript but never forward it through the SDK iterator.
 */
export class SdkFirstResponseWatchdog {
  private inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  private retryLimitTimer: ReturnType<typeof setTimeout> | undefined;
  private activePhase: SdkFirstResponseWatchdogPhase | undefined;
  private timedOut = false;
  private readonly firstResponseStartedAt = Date.now();

  constructor(
    readonly timeoutMs: number,
    private readonly onTimeout: (
      phase: SdkFirstResponseWatchdogPhase,
      timeoutMs: number,
    ) => void,
    private readonly maxRetryWaitMs = timeoutMs * 3,
  ) {
    this.arm(timeoutMs, 'first_response');
  }

  observe(messageType: string, messageSubtype?: string): void {
    if (messageType === 'system' && messageSubtype === 'api_retry') {
      this.observeApiRetry();
      return;
    }
    if (!FIRST_RESPONSE_MESSAGE_TYPES.has(messageType)) return;
    this.clear();
  }

  /**
   * An SDK api_retry event proves the provider request is still making
   * progress. Treat it as a heartbeat and give the next attempt one fresh
   * inactivity window. A separate absolute deadline prevents a noisy retry
   * loop from keeping the runner alive forever; it must not replace the
   * rolling inactivity timer because the SDK's own bounded backoff can
   * legitimately span several minutes.
   */
  private observeApiRetry(): void {
    if (
      this.timedOut ||
      (this.activePhase !== 'first_response' &&
        this.activePhase !== 'api_retry')
    ) {
      return;
    }

    if (!this.retryLimitTimer) {
      const remainingMs = Math.max(
        0,
        this.firstResponseStartedAt + this.maxRetryWaitMs - Date.now(),
      );
      this.retryLimitTimer = setTimeout(
        () => this.finishTimeout('api_retry_limit', this.maxRetryWaitMs),
        remainingMs,
      );
      this.retryLimitTimer.unref?.();
    }
    this.arm(this.timeoutMs, 'api_retry');
  }

  /**
   * Replace the short first-response deadline with one bounded allowance for
   * SDK auto-compaction. The SDK exposes PreCompact but no matching completion
   * hook, so this deadline covers both the summarization round-trip and the
   * first real model response that follows it. Repeated PreCompact callbacks
   * cannot keep extending the deadline indefinitely.
   */
  beginCompaction(timeoutMs: number): void {
    if (this.timedOut || this.activePhase === 'compaction') return;
    if (this.retryLimitTimer) clearTimeout(this.retryLimitTimer);
    this.retryLimitTimer = undefined;
    this.arm(timeoutMs, 'compaction');
  }

  clear(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (this.retryLimitTimer) clearTimeout(this.retryLimitTimer);
    this.inactivityTimer = undefined;
    this.retryLimitTimer = undefined;
    this.activePhase = undefined;
  }

  private arm(
    timeoutMs: number,
    phase: SdkFirstResponseWatchdogPhase,
    reportedTimeoutMs = timeoutMs,
  ): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = undefined;
    this.activePhase = phase;
    this.inactivityTimer = setTimeout(() => {
      this.finishTimeout(phase, reportedTimeoutMs);
    }, timeoutMs);
    this.inactivityTimer.unref?.();
  }

  private finishTimeout(
    phase: SdkFirstResponseWatchdogPhase,
    reportedTimeoutMs: number,
  ): void {
    if (this.timedOut) return;
    this.timedOut = true;
    this.clear();
    this.onTimeout(phase, reportedTimeoutMs);
  }
}
