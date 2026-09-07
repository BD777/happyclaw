import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// Integration wiring regression: a retry has no durable card reservation, so
// both routing paths must leave final publication to the exact-turn Outbox.
describe('retry card admission wiring', () => {
  const source = fs.readFileSync('src/index.ts', 'utf8');
  test('the agent route cannot create an untracked card on a retry', () => {
    const start = source.indexOf('  let agentStreamingSession =');
    const end = source.indexOf('  const agentStreamingSessionsByInput', start);
    const creation = source.slice(start, end);
    expect(creation).toMatch(/agentRetryAttempt === 0\s*&&/);
    expect(creation).toContain('activeAgentDurableCardLifecycle');
  });
  test('the main route also uses static delivery for retries', () => {
    expect(source).toMatch(/let streamingSession =\s*retryAttempt > 0/);
  });
});
