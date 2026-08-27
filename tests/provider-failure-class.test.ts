import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  PROVIDER_FAILURE_USER_NOTICE,
  PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
  PROVIDER_MODEL_CONFIG_USER_NOTICE,
  PROVIDER_TRANSIENT_ESCALATED_USER_NOTICE,
  PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
  resolveProviderFailureClass,
  resolveTerminalProviderFailureNotice,
} from '../src/provider-failure.js';

const hostRunner = readFileSync('src/container-runner.ts', 'utf8');
const hostIndex = readFileSync('src/index.ts', 'utf8');
const agentRunner = readFileSync('container/agent-runner/src/index.ts', 'utf8');

describe('provider failure class resolution', () => {
  test('honours the class the runner reported', () => {
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'transient' }),
    ).toBe('transient');
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'config' }),
    ).toBe('config');
    expect(
      resolveProviderFailureClass({ providerFailureClass: 'account' }),
    ).toBe('account');
  });

  test('an unclassified failure keeps the historical account disposition', () => {
    // A runner built before the classification still frames outputs without the
    // field. Defaulting to `transient` there would silently stop quarantining a
    // genuinely dead account, so the safe default is the old behaviour.
    expect(resolveProviderFailureClass({})).toBe('account');
  });

  test('a batch-1 stall flag alone still avoids the account verdict', () => {
    // The liveness flag shipped one commit before the class did. An output
    // carrying only the flag must keep the never-quarantine disposition rather
    // than regress to the quota verdict the flag was introduced to remove.
    expect(resolveProviderFailureClass({ providerLivenessTimeout: true })).toBe(
      'transient',
    );
  });
});

describe('terminal provider failure notices', () => {
  test('each class names its own cause and none reuses the quota wording', () => {
    const notices = [
      PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE,
      PROVIDER_TRANSIENT_FAILURE_USER_NOTICE,
      PROVIDER_MODEL_CONFIG_USER_NOTICE,
    ];
    expect(new Set(notices).size).toBe(notices.length);
    for (const notice of notices) {
      expect(notice).not.toBe(PROVIDER_FAILURE_USER_NOTICE);
      expect(notice).not.toContain('额度已用尽');
    }
    // A config failure is the one case the user must act on, so it has to say
    // what to fix instead of suggesting a retry.
    expect(PROVIDER_MODEL_CONFIG_USER_NOTICE).toContain('模型配置');
    expect(PROVIDER_MODEL_CONFIG_USER_NOTICE).not.toContain('请稍后重新发送');
  });

  test('a silent stall and a reported upstream error are worded apart', () => {
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
        providerLivenessTimeout: true,
      }),
    ).toBe(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE);
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'transient',
      }),
    ).toBe(PROVIDER_TRANSIENT_FAILURE_USER_NOTICE);
  });

  test('a config failure gets the configuration notice', () => {
    expect(
      resolveTerminalProviderFailureNotice({ providerFailureClass: 'config' }),
    ).toBe(PROVIDER_MODEL_CONFIG_USER_NOTICE);
  });

  test('an escalated transient failure says the account was taken out, not that quota ran out', () => {
    const notice = resolveTerminalProviderFailureNotice({
      providerFailureClass: 'account',
      providerFailureEscalatedFrom: 'transient',
      providerLivenessTimeout: true,
    });
    expect(notice).toBe(PROVIDER_TRANSIENT_ESCALATED_USER_NOTICE);
    // By this point the account is quarantined, so telling the user to just
    // resend would be a lie — the next message would fail the same way.
    expect(notice).toContain('已暂时停用该账号');
    expect(notice).not.toBe(PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE);
    expect(notice).not.toBe(PROVIDER_FAILURE_USER_NOTICE);
  });

  test('escalation is recorded explicitly, never inferred from the stall flag', () => {
    // `account` + `livenessTimeout` happens to be the escalation signature, but
    // reading a disposition off an unrelated flag is the original defect. A
    // stall flag with no escalation marker must not select the escalated notice.
    expect(
      resolveTerminalProviderFailureNotice({
        providerFailureClass: 'account',
        providerLivenessTimeout: true,
      }),
    ).toBeUndefined();
  });

  test('an account failure keeps whatever notice the caller already resolved', () => {
    // Account walls carry the upstream limit text or the generic pool notice;
    // overwriting them here would discard the reset time the user needs.
    expect(
      resolveTerminalProviderFailureNotice({ providerFailureClass: 'account' }),
    ).toBeUndefined();
    expect(resolveTerminalProviderFailureNotice({})).toBeUndefined();
  });
});

describe('host disposition is keyed on the class, not on individual flags', () => {
  test('only an account verdict may change account health', () => {
    expect(hostRunner).toContain(
      "if (resolveProviderFailureClass(output) !== 'account') return;",
    );
    // The pre-classification guard checked one concrete flag, so every later
    // non-account failure would have slipped past it into the quarantine.
    expect(hostRunner).not.toContain(
      'if (output.providerLivenessTimeout) return;',
    );
  });

  test('transient failures are replayed and never consult the pool', () => {
    expect(hostRunner).toMatch(
      /if \(failureClass === 'transient'\) \{[\s\S]*?transientRetries\.consume\(resolveTransientRetryKey\(output\)\)/,
    );
    // Ordering matters: refreshFromConfig/poolCanStillServe must stay below the
    // transient branch, or a 529 would still be answered by a failover.
    const transientBranch = hostRunner.indexOf(
      "if (failureClass === 'transient')",
    );
    const poolRefresh = hostRunner.indexOf('providerPool.refreshFromConfig(');
    expect(transientBranch).toBeGreaterThan(-1);
    expect(poolRefresh).toBeGreaterThan(transientBranch);
  });

  test('a repeated transient failure escalates to an account verdict', () => {
    // Ordering, asserted by position rather than adjacency so that inserting a
    // log line between the steps does not read as a regression:
    //
    //   class rewrite  ->  quarantine  ->  pool disposition
    //
    // The rewrite must come first or quarantineFromOutput's own `!== 'account'`
    // guard skips the very quarantine the escalation exists to perform, and the
    // pool step must come last or a multi-account install never fails over.
    // The behavioural proof lives in provider-transient-escalation.test.ts;
    // this only pins the order the two functions have to be called in.
    const rewrite = hostRunner.indexOf(
      "output.providerFailureClass = 'account';",
    );
    const escalation = hostRunner.indexOf(
      "output.providerFailureEscalatedFrom = 'transient';",
    );
    const quarantine = hostRunner.indexOf(
      'quarantineFromOutput(selectedProfileId, output);',
    );
    const poolRefresh = hostRunner.indexOf('providerPool.refreshFromConfig(');
    expect(rewrite).toBeGreaterThan(-1);
    expect(escalation).toBeGreaterThan(rewrite);
    expect(quarantine).toBeGreaterThan(escalation);
    expect(poolRefresh).toBeGreaterThan(quarantine);
  });

  test('the first transient failure still replays without touching the account', () => {
    expect(hostRunner).toMatch(
      /if \(transientRetries\.consume\(resolveTransientRetryKey\(output\)\)\) \{\s*applyKnownProviderFailureDisposition\(output, false\);\s*return false;\s*\}/,
    );
  });

  test('config failures end immediately without a quarantine or a retry', () => {
    expect(hostRunner).toMatch(
      /if \(failureClass === 'config'\) \{[\s\S]*?applyKnownProviderFailureDisposition\(output, true\);[\s\S]*?return true;/,
    );
  });

  test('a session is cleared only for a real account switch', () => {
    expect(hostIndex).toContain(
      "resolveProviderFailureClass(output) === 'account' &&",
    );
    expect(hostIndex).not.toContain('!output.providerLivenessTimeout &&');
  });
});

describe('model fallback is visible to the user', () => {
  test('every activation path announces the downgrade before retrying', () => {
    const activations = agentRunner.match(
      /PROVIDER_FALLBACK_MODELS\.activateForScope\(/g,
    );
    expect(activations?.length).toBe(2);
    // A silent downgrade is indistinguishable from a primary-model reply, so
    // both retry paths must announce it — not just the structured one.
    expect(agentRunner.match(/emitModelFallbackNotice\(\);/g)?.length).toBe(2);
    expect(agentRunner).toContain("sourceKind: 'provider_fallback_notice'");
  });

  test('the notice names both models so the user can act on it', () => {
    expect(agentRunner).toContain('PROVIDER_FALLBACK_MODELS.primaryModel');
    expect(agentRunner).toMatch(
      /emitModelFallbackNotice[\s\S]{0,900}PROVIDER_FALLBACK_MODELS\.fallbackModel/,
    );
  });

  test('the notice is emitted before the retry marker, not after the answer', () => {
    // The notice has to precede providerFailureRetrying: emitting it later
    // would put it after the fallback answer the user is reading.
    for (const marker of agentRunner.matchAll(
      /emitModelFallbackNotice\(\);/g,
    )) {
      const after = agentRunner.slice(
        marker.index ?? 0,
        (marker.index ?? 0) + 400,
      );
      expect(after).toContain('providerFailureRetrying: true');
    }
  });
});
