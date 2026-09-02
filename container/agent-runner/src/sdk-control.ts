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
  private timer: ReturnType<typeof setTimeout> | undefined;
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
   * progress. Give the next attempt one fresh first-response window, while an
   * absolute deadline prevents a noisy retry loop from keeping the runner
   * alive forever.
   */
  private observeApiRetry(): void {
    if (
      this.timedOut ||
      (this.activePhase !== 'first_response' &&
        this.activePhase !== 'api_retry')
    ) {
      return;
    }

    const remainingMs =
      this.firstResponseStartedAt + this.maxRetryWaitMs - Date.now();
    if (remainingMs <= this.timeoutMs) {
      this.arm(
        Math.max(0, remainingMs),
        'api_retry_limit',
        this.maxRetryWaitMs,
      );
      return;
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
    this.arm(timeoutMs, 'compaction');
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.activePhase = undefined;
  }

  private arm(
    timeoutMs: number,
    phase: SdkFirstResponseWatchdogPhase,
    reportedTimeoutMs = timeoutMs,
  ): void {
    this.clear();
    this.activePhase = phase;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.activePhase = undefined;
      this.timedOut = true;
      this.onTimeout(phase, reportedTimeoutMs);
    }, timeoutMs);
  }
}
