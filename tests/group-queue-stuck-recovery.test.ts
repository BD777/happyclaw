import { afterEach, describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GroupQueue } from '../src/group-queue.js';
import { DATA_DIR } from '../src/config.js';

// Regression coverage for #618: warm-path IPC follow-ups must be visible to
// stuck-runner recovery. Follow-ups injected into a live runner set
// hasIpcInjectedMessages without re-arming pendingMessages, so a wedged
// in-flight turn with injected input was invisible to getStuckPendingGroups
// and the user got no reply until a manual kill.
//
// State is seeded directly into the internal map (same approach as
// conversation-agent-warm-lifecycle.test.ts) so the tests stay hermetic.

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;

interface SeedOpts {
  active?: boolean;
  groupFolder?: string;
  agentId?: string | null;
  queryInFlight?: boolean;
  activeRunnerIsTask?: boolean;
  lastActivityAt?: number | null;
  pendingMessages?: boolean;
  hasIpcInjectedMessages?: boolean;
}

function seedRunner(q: GroupQueue, jid: string, opts: SeedOpts = {}) {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  anyQ.groups.set(jid, {
    active: opts.active ?? true,
    activeRunnerIsTask: opts.activeRunnerIsTask ?? false,
    lastActivityAt: opts.lastActivityAt ?? null,
    queryInFlight: opts.queryInFlight ?? false,
    pendingMessages: opts.pendingMessages ?? false,
    pendingTasks: [],
    process: null,
    containerName: null,
    displayName: null,
    groupFolder: opts.groupFolder ?? 'main',
    agentId: opts.agentId ?? null,
    taskRunId: null,
    retryCount: 0,
    retryTimer: null,
    restarting: false,
    selectedProviderId: null,
    drainSentinelWritten: false,
    hasIpcInjectedMessages: opts.hasIpcInjectedMessages ?? false,
  });
}

function getState(q: GroupQueue, jid: string): Record<string, unknown> {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  return anyQ.groups.get(jid)!;
}

describe('#618: IPC-injected follow-ups are visible to stuck recovery', () => {
  const folder = `stuck-test-${process.pid}-${Date.now()}`;
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);

  afterEach(() => {
    fs.rmSync(ipcDir, { recursive: true, force: true });
  });

  test('wedged in-flight turn with injected input is reported as stuck (ipc_injected)', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].jid).toBe(jid);
    expect(stuck[0].reason).toBe('ipc_injected');
    expect(stuck[0].idleMs).toBeGreaterThanOrEqual(IDLE_THRESHOLD_MS);
  });

  test('warm runner idle between turns is NOT stuck: turn completed, no owed work', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    // hasIpcInjectedMessages stays true for the runner lifetime (exit-replay
    // safety), but queryInFlight=false means the runner reported the turn
    // idle. IDLE_TIMEOUT owns this runner, not stuck recovery.
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: false,
      hasIpcInjectedMessages: true,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('pendingMessages path still reports stuck with pending_messages reason', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      pendingMessages: true,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('pending_messages');
  });

  test('a recently injected follow-up is not stuck: sendMessage restarts the idle window', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    // Warm runner sitting idle long past the threshold when the user's
    // follow-up arrives. Without the lastActivityAt refresh at inject time,
    // the runner would look instantly stuck and get restarted before it had
    // any chance to answer.
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: false,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.sendMessage(jid, 'follow-up message')).toBe('sent');
    expect(getState(q, jid).hasIpcInjectedMessages).toBe(true);
    expect(getState(q, jid).queryInFlight).toBe(true);
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('markIpcInjectedMessage restarts the idle window', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      lastActivityAt: 1,
    });

    const before = Date.now();
    q.markIpcInjectedMessage(jid);
    const after = Date.now();

    const last = getState(q, jid).lastActivityAt as number;
    expect(last).toBeGreaterThanOrEqual(before);
    expect(last).toBeLessThanOrEqual(after);
  });

  test('in-flight injected turn below the idle threshold is not stuck', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      lastActivityAt: Date.now() - 30_000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('runtime-session (agentId) runners remain excluded from stuck recovery', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}#agent:sess1`;
    seedRunner(q, jid, {
      groupFolder: folder,
      agentId: 'sess1',
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });
});
