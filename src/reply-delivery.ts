/**
 * Pure decision logic for whether a scheduled-task/message-processing run
 * genuinely delivered a reply to the user, and whether that genuine
 * delivery should block a retry after a late-turn error. Extracted from
 * processGroupMessages (src/index.ts) so the two directions of this
 * decision — "was this result actually complete?" and "does a mid-turn
 * send_message delivery also count?" — are independently unit-testable
 * without the surrounding IO/streaming machinery.
 */

export interface ReplyResultInfo {
  /**
   * Non-null means this result is an interim checkpoint, not the final
   * answer: 'bg_tasks' (background tasks still settling) or 'truncated'
   * (upstream stream cut off, auto-continuing).
   */
  holdReason: 'bg_tasks' | 'truncated' | null;
  sourceKind?: string;
  finalizationReason?: string;
}

/**
 * True only when this result represents content actually finished and
 * delivered — never for an interim checkpoint. A held/partial result must
 * NOT count as "the user got a reply" for the purpose of skipping a retry
 * after a later error: the user may never see the rest of a truncated or
 * still-settling answer if the cursor gets committed on this checkpoint.
 */
export function isGenuineReplyResult(info: ReplyResultInfo): boolean {
  if (info.holdReason) return false;
  if (
    info.sourceKind === 'overflow_partial' ||
    info.sourceKind === 'compact_partial'
  ) {
    return false;
  }
  if (info.finalizationReason === 'truncated') return false;
  return true;
}

export interface RetrySkipDecisionInput {
  /** Set once a genuine (isGenuineReplyResult) result was delivered this run. */
  genuineReplyDelivered: boolean;
  /**
   * True only after the host has successfully delivered a send_message for
   * this exact input turn. The caller must correlate by the immutable IPC
   * delivery id (or the cold-start message id), never by folder/chat/time.
   */
  ipcReplyDeliveredForInputTurn: boolean;
}

/**
 * Read a genuine SDK-final acknowledgement by immutable input id.
 *
 * Warm runners can activate input B before a delayed callback for input A
 * arrives. Callers must therefore never collapse this ledger into a
 * runner-wide boolean: A's late final is not evidence that B was delivered.
 */
export function wasGenuineReplyDeliveredForInput(
  deliveredByInput: ReadonlyMap<string, boolean>,
  inputTurnId: string,
): boolean {
  return deliveredByInput.get(inputTurnId) === true;
}

export interface IpcReplyTurnTracker {
  inputTurnId: string;
  delivered: boolean;
}

/** Move a warm runner to a new input turn. Acknowledgement state must reset
 * even when the reply route/JID itself did not change. */
export function setIpcReplyInputTurn(
  tracker: IpcReplyTurnTracker,
  inputTurnId: string,
): void {
  tracker.inputTurnId = inputTurnId;
  tracker.delivered = false;
}

/** Apply a host delivery acknowledgement only when it names the exact input
 * turn that is still active. Late output from an older turn is ignored. */
export function acknowledgeIpcReplyTurn(
  tracker: IpcReplyTurnTracker,
  inputTurnId: string,
): boolean {
  if (inputTurnId !== tracker.inputTurnId) return false;
  tracker.delivered = true;
  return true;
}

/**
 * True when a retry must be skipped (cursor committed instead) because the
 * user already genuinely received something for this exact input — either
 * the final SDK result, or a host-acknowledged send_message MCP call.
 */
export function shouldSkipRetryAfterLateError(
  input: RetrySkipDecisionInput,
): boolean {
  return input.genuineReplyDelivered || input.ipcReplyDeliveredForInputTurn;
}
