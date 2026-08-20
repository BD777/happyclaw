/**
 * One-time diagnostic/repair for leftover JID-classifiable DMs still bound to
 * workspace main (`target_main_jid`). This is not a schema migration.
 *
 * Supported main never produced this state after #659+#655 landed together.
 * The tool exists for cherry-picked / interim installs, per the #663 close
 * reason: remounting without a new isolation generation can leave a
 * contaminated main session and post-marker rows recoverable.
 *
 * Usage:
 *   npx tsx scripts/repair-leftover-direct-mounts.ts
 *   npx tsx scripts/repair-leftover-direct-mounts.ts --apply
 *   make leftover-direct-mounts
 *   make leftover-direct-mounts APPLY=1
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { STORE_DIR, WEB_PORT } from '../src/config.js';
import {
  closeDatabase,
  CURRENT_SCHEMA_VERSION,
  initDatabase,
} from '../src/db.js';
import {
  diagnoseLeftoverClassifiableDirectWorkspaceMounts,
  repairLeftoverClassifiableDirectWorkspaceMounts,
  type LeftoverDirectMountDiagnosis,
  type LeftoverDirectMountRepairResult,
} from '../src/leftover-direct-mount-repair.js';

const DATABASE_PATH = path.join(STORE_DIR, 'messages.db');

function printUsage(): void {
  console.log(`Diagnose leftover JID-classifiable DMs still on workspace main.

This is a one-time tool, not a schema migration. Dry-run is the default.
Repair remounts onto channel_direct and resets isolation/recovery with a
new generation so contaminated main sessions and post-marker rows cannot
stay recoverable.

Usage:
  npx tsx scripts/repair-leftover-direct-mounts.ts
  npx tsx scripts/repair-leftover-direct-mounts.ts --apply
  make leftover-direct-mounts
  make leftover-direct-mounts APPLY=1

Exit codes:
  0  no leftovers, or --apply succeeded
  1  usage / runtime error
  2  leftovers found (dry-run only)
`);
}

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    printUsage();
    process.exit(1);
  }
  return { apply };
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function assertServiceStopped(): Promise<void> {
  const listening =
    (await canConnect('127.0.0.1', WEB_PORT)) ||
    (await canConnect('::1', WEB_PORT));
  if (listening) {
    throw new Error(
      `Refusing --apply while a service is listening on port ${WEB_PORT}. Stop HappyClaw first (make stop).`,
    );
  }
}

function printDiagnosis(diagnosis: LeftoverDirectMountDiagnosis): void {
  console.log('HappyClaw leftover classifiable DM diagnostic');
  console.log(`Schema version: ${diagnosis.schemaVersion}`);
  console.log(`CURRENT_SCHEMA_VERSION: ${CURRENT_SCHEMA_VERSION}`);
  console.log(`Database: ${DATABASE_PATH}`);
  console.log('');

  if (diagnosis.leftovers.length === 0) {
    console.log(
      'No leftover JID-classifiable DMs are bound to target_main_jid.',
    );
    return;
  }

  console.log(
    `Found ${diagnosis.leftovers.length} leftover direct mount(s) on workspace main:`,
  );
  for (const [index, leftover] of diagnosis.leftovers.entries()) {
    console.log('');
    console.log(`${index + 1}. ${leftover.channelJid}`);
    console.log(
      `   workspace: ${leftover.workspaceJid} (${leftover.workspaceFolder})`,
    );
    if (leftover.channelAccountId) {
      console.log(`   channel account: ${leftover.channelAccountId}`);
    }
    console.log(`   main owner: ${leftover.mainOwnerJid ?? '(none)'}`);
    console.log(`   main owner is this chat: ${leftover.mainOwnerIsThisChat}`);
    console.log(`   main session: ${leftover.mainSessionId ?? '(none)'}`);
    console.log(
      `   isolation marker: ${leftover.existingIsolationMarker ?? '(none)'}`,
    );
    console.log(
      `   recoverable inbound from this chat: ${leftover.recoverableInboundFromThisChat}`,
    );
  }

  console.log('');
  console.log(
    'Affected workspaces (a repair would reset isolation generation):',
  );
  for (const workspace of diagnosis.affectedWorkspaces) {
    console.log(
      `- ${workspace.workspaceJid} leftovers=${workspace.leftoverCount} marker=${
        workspace.existingIsolationMarker ?? '(none)'
      } recoverable_leaks=${workspace.recoverableInboundFromLeftovers} main_session=${
        workspace.mainSessionId ?? '(none)'
      }`,
    );
  }
}

function printRepair(result: LeftoverDirectMountRepairResult): void {
  console.log('');
  console.log(
    `Repaired ${result.remounted} leftover mount(s). Reset isolation generation for ${result.isolationGenerationsReset} workspace(s).`,
  );
  for (const [workspaceJid, marker] of Object.entries(
    result.isolationMarkers,
  )) {
    console.log(`  ${workspaceJid} -> ${marker}`);
  }
  console.log(`Schema version remains ${result.schemaVersion}.`);
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DATABASE_PATH)) {
    console.log(`No database at ${DATABASE_PATH}; nothing to diagnose.`);
    return;
  }

  if (apply) {
    await assertServiceStopped();
  }

  initDatabase();
  try {
    if (!apply) {
      const diagnosis = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
      console.log('Mode: dry-run (no writes)');
      printDiagnosis(diagnosis);
      if (diagnosis.leftovers.length === 0) return;
      console.log('');
      console.log(
        'No changes written. Re-run with --apply to remount onto channel_direct and reset isolation/recovery state with a new generation.',
      );
      process.exitCode = 2;
      return;
    }

    const before = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
    console.log('Mode: apply');
    printDiagnosis(before);
    if (before.leftovers.length === 0) return;

    const result = repairLeftoverClassifiableDirectWorkspaceMounts({
      apply: true,
    });
    printRepair(result);
  } finally {
    closeDatabase();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
