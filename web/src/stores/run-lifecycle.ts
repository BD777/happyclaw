export interface ClientActiveRun {
  chatJid: string;
  runId: string;
  startedAt: string;
  phase: 'queued' | 'preparing' | 'running';
}

export type ClientActiveRuns = Record<string, ClientActiveRun>;

export interface RuntimeQueryStatus {
  queryInFlight?: boolean;
  queryId?: string | null;
}

/** Only exact attempts can restore waiting because only they have a terminal. */
export function hasExactQueryAttempt(status: RuntimeQueryStatus): boolean {
  return status.queryInFlight === true && !!status.queryId;
}

/** A start for the same runtime JID supersedes its older attempt. */
export function applyRunStarted(
  current: ClientActiveRuns,
  run: ClientActiveRun,
): ClientActiveRuns {
  return { ...current, [run.chatJid]: run };
}

/** Remove only the attempt named by the terminal event. */
export function applyRunFinished(
  current: ClientActiveRuns,
  chatJid: string,
  runId: string,
): { runs: ClientActiveRuns; applied: boolean } {
  if (current[chatJid]?.runId !== runId) {
    return { runs: current, applied: false };
  }
  const runs = { ...current };
  delete runs[chatJid];
  return { runs, applied: true };
}

/** Reconnect snapshots are authoritative for server-owned query attempts. */
export function runsFromAuthoritativeSnapshot(
  runs: ClientActiveRun[],
): ClientActiveRuns {
  return Object.fromEntries(
    runs
      .filter(
        (run): run is ClientActiveRun =>
          typeof run?.chatJid === 'string' &&
          run.chatJid.length > 0 &&
          typeof run.runId === 'string' &&
          run.runId.length > 0,
      )
      .map((run) => [run.chatJid, run]),
  );
}

/**
 * Live stream payloads are owned by an exact query attempt. Unowned legacy
 * payloads are fail-closed because they have no matching terminal boundary.
 */
export function shouldApplyRunScopedPayload(
  current: ClientActiveRuns,
  chatJid: string,
  runId?: string,
): boolean {
  return !!runId && current[chatJid]?.runId === runId;
}

/** A reconnect replacement must discard the prior attempt's local stream. */
export function shouldDiscardStreamForAuthoritativeRun(
  previous: ClientActiveRuns,
  authoritative: ClientActiveRuns,
  chatJid: string,
): boolean {
  const next = authoritative[chatJid];
  if (!next) return true;
  return previous[chatJid]?.runId !== next.runId;
}
