import type {
  ActiveTurnOutputRegistry,
  ProactiveFinalRecoveryDecision,
} from './turn-output-coordinator.js';

export interface ProactiveFinalFallbackDelivery {
  /** The canonical Web session contains the recovered final answer. */
  projected: boolean;
  /** The native target, when present, physically ACKed the recovered answer. */
  targetDelivered: boolean;
  path: 'native' | 'web' | 'web_after_native_failure';
}

export interface ProactiveFinalRecoveryResult {
  attempted: boolean;
  projected: boolean;
  targetDelivered: boolean;
  path?: ProactiveFinalFallbackDelivery['path'];
  reason:
    | ProactiveFinalRecoveryDecision['reason']
    | 'incomplete_turn'
    | 'reply_limit_reached';
}

/**
 * Recover hidden SDK final text without duplicating an acknowledged Proactive
 * final message.
 *
 * The registry is the process-local view of user-visible projections. Native
 * physical acknowledgement remains a distinct result so a Web recovery cannot
 * accidentally settle provider-delivery accounting.
 */
export async function recoverProactiveFinalCandidate(input: {
  registry: ActiveTurnOutputRegistry;
  scopeKey: string;
  inputTurnId: string;
  inputTurnCompleted: boolean | undefined;
  candidate: string | null | undefined;
  canDeliver: () => boolean;
  deliver: (text: string) => Promise<ProactiveFinalFallbackDelivery>;
}): Promise<ProactiveFinalRecoveryResult> {
  if (!input.inputTurnCompleted) {
    return {
      attempted: false,
      projected: false,
      targetDelivered: false,
      reason: 'incomplete_turn',
    };
  }
  const decision = input.registry.resolveProactiveFinalRecovery({
    scopeKey: input.scopeKey,
    inputTurnId: input.inputTurnId,
    text: input.candidate,
  });
  if (!decision.deliver || !decision.text) {
    return {
      attempted: false,
      projected: false,
      targetDelivered: false,
      reason: decision.reason,
    };
  }
  if (!input.canDeliver()) {
    return {
      attempted: false,
      projected: false,
      targetDelivered: false,
      reason: 'reply_limit_reached',
    };
  }

  const delivery = await input.deliver(decision.text);
  if (delivery.projected) {
    input.registry.recordProjectedUtterance({
      scopeKey: input.scopeKey,
      inputTurnId: input.inputTurnId,
      role: 'final',
      text: decision.text,
    });
  }
  return {
    attempted: true,
    projected: delivery.projected,
    targetDelivered: delivery.targetDelivered,
    path: delivery.path,
    reason: decision.reason,
  };
}
