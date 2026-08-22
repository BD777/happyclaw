import { describe, expect, test, vi } from 'vitest';

// Two enabled accounts so the escalated verdict has somewhere to fail over to;
// individual tests narrow this to one account where that is the case under test.
const mocks = vi.hoisted(() => ({
  enabledProviders: [
    {
      id: 'escalation-a',
      enabled: true,
      weight: 1,
      anthropicModel: 'primary-model',
    },
    {
      id: 'escalation-b',
      enabled: true,
      weight: 1,
      anthropicModel: 'primary-model',
    },
  ],
  fallbackModel: '',
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getEnabledProviders: () => mocks.enabledProviders,
    getSystemSettings: () => ({
      ...actual.getSystemSettings(),
      fallbackModel: mocks.fallbackModel,
    }),
  };
});

const { applyProviderFailureDisposition } =
  await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');
const {
  PROVIDER_TRANSIENT_ESCALATED_USER_NOTICE,
  PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
} = await import('../src/provider-failure.js');
type ContainerOutput = import('../src/container-runner.js').ContainerOutput;

/** One liveness stall for a given durable input, as the runner would frame it. */
function stall(messageId: string): ContainerOutput {
  return {
    status: 'success',
    result: null,
    providerFailure: true,
    providerFailureClass: 'transient',
    providerLivenessTimeout: true,
    providerRateLimitScope: 'account',
    // The ledger keys on the durable message id carried by the receipt cursor,
    // which is what survives a replay.
    ipcReceipts: [
      {
        deliveryId: `delivery-${Math.random()}`,
        chatJid: 'web:x',
        cursor: { id: messageId },
      },
    ],
  } as ContainerOutput;
}

function resetPool(): void {
  for (const p of mocks.enabledProviders) providerPool.resetHealth(p.id);
}

describe('transient failure escalation', () => {
  test('the first stall replays without judging the account', () => {
    resetPool();
    const first = stall('msg-first-only');
    const terminal = applyProviderFailureDisposition(first, 'escalation-a');

    expect(terminal).toBe(false);
    expect(first.providerFailureTerminal).toBe(false);
    // Not retired: the durable input must stay replayable.
    expect(first.inputTurnCompleted).toBe(false);
    expect(first.providerFailureClass).toBe('transient');
    expect(first.providerFailureEscalatedFrom).toBeUndefined();
    expect(providerPool.getHealthStatus('escalation-a').healthy).toBe(true);
  });

  test('a second stall on the same input quarantines the account and fails over', () => {
    resetPool();
    const id = 'msg-escalates';
    applyProviderFailureDisposition(stall(id), 'escalation-a');

    const second = stall(id);
    const terminal = applyProviderFailureDisposition(second, 'escalation-a');

    expect(second.providerFailureClass).toBe('account');
    expect(second.providerFailureEscalatedFrom).toBe('transient');
    // The rewrite has to happen before quarantineFromOutput, whose own guard
    // skips anything that is not account-class.
    expect(providerPool.getHealthStatus('escalation-a').healthy).toBe(false);
    // The other account is untouched, so the input replays there instead of
    // ending — this is the multi-account failover the escalation restores.
    expect(providerPool.getHealthStatus('escalation-b').healthy).toBe(true);
    expect(terminal).toBe(false);
    expect(second.inputTurnCompleted).toBe(false);
  });

  test('the budget is per input, so an unrelated message still gets its replay', () => {
    resetPool();
    const id = 'msg-a';
    applyProviderFailureDisposition(stall(id), 'escalation-a');
    applyProviderFailureDisposition(stall(id), 'escalation-a');

    resetPool();
    const other = stall('msg-b');
    expect(applyProviderFailureDisposition(other, 'escalation-a')).toBe(false);
    expect(other.providerFailureClass).toBe('transient');
    expect(providerPool.getHealthStatus('escalation-a').healthy).toBe(true);
  });

  test('a single-account pool ends with the escalated notice, not the stall one', () => {
    const saved = mocks.enabledProviders;
    mocks.enabledProviders = [saved[0]];
    try {
      resetPool();
      const id = 'msg-single-account';
      const first = stall(id);
      expect(applyProviderFailureDisposition(first, 'escalation-a')).toBe(
        false,
      );
      // While it is still transient the user is told it is a stall.
      expect(first.providerFailureNotice).toBeUndefined();

      const second = stall(id);
      const terminal = applyProviderFailureDisposition(second, 'escalation-a');

      expect(terminal).toBe(true);
      expect(second.inputTurnCompleted).toBe(true);
      expect(second.providerFailureNotice).toBe(
        PROVIDER_TRANSIENT_ESCALATED_USER_NOTICE,
      );
      // Inviting a resend would be wrong: the account is quarantined now.
      expect(second.providerFailureNotice).not.toBe(
        PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
      );
      expect(providerPool.getHealthStatus('escalation-a').healthy).toBe(false);
    } finally {
      mocks.enabledProviders = saved;
      resetPool();
    }
  });
});
