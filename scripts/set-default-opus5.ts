/**
 * Pin every enabled official Claude provider to the exact Opus 5 model ID and
 * set windeng's and aqiu's default Agent profiles to explicit high effort.
 *
 * Usage (HappyClaw must be stopped):
 *   npx tsx scripts/set-default-opus5.ts --apply
 *
 * This command intentionally creates no database, runtime, or .env backup.
 * Model and effort changes invalidate only provider-bound SDK resume sessions;
 * messages, Workspace Memory, Agent Profiles, channel configuration, and files
 * remain.
 */
import '../src/load-env.js';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  acquireDatabaseMaintenanceGuard,
  DATABASE_MAINTENANCE_TOKEN_ENV,
  releaseDatabaseMaintenanceGuard,
} from '../src/database-maintenance.js';

const TARGET_MODEL = 'claude-opus-5';
const TARGET_EFFORT = 'high' as const;
const TARGET_USERNAMES = ['windeng', 'aqiu'] as const;
const DATABASE_PATH = path.join(process.cwd(), 'data', 'db', 'messages.db');
const execFileAsync = promisify(execFile);

function parseArgs(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npx tsx scripts/set-default-opus5.ts --apply');
    process.exit(0);
  }
  if (args.length !== 1 || args[0] !== '--apply') {
    throw new Error(
      'Refusing to change the default model and effort without --apply',
    );
  }
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
  const port = Number.parseInt(process.env.WEB_PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WEB_PORT: ${process.env.WEB_PORT}`);
  }
  if (
    (await canConnect('127.0.0.1', port)) ||
    (await canConnect('::1', port))
  ) {
    throw new Error(`HappyClaw still listens on port ${port}; stop it first`);
  }
}

function sqliteSidecarPaths(): string[] {
  return [
    `${DATABASE_PATH}-wal`,
    `${DATABASE_PATH}-shm`,
    `${DATABASE_PATH}-journal`,
  ];
}

function assertNoSqliteSidecars(): void {
  const present = sqliteSidecarPaths().filter((candidate) =>
    fs.existsSync(candidate),
  );
  if (present.length > 0) {
    throw new Error(
      `SQLite sidecars remain after shutdown: ${present.join(', ')}`,
    );
  }
}

async function assertDatabaseUnused(): Promise<void> {
  const candidates = [DATABASE_PATH, ...sqliteSidecarPaths()].filter(
    (candidate) => fs.existsSync(candidate),
  );
  if (candidates.length === 0) {
    throw new Error(`Database not found: ${DATABASE_PATH}`);
  }
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-t', '--', ...candidates],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    throw new Error(
      `Database is still open by process(es): ${stdout.trim().split(/\s+/).join(', ')}`,
    );
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    if (
      commandError.code === 1 &&
      !commandError.stdout?.trim() &&
      !commandError.stderr?.trim()
    ) {
      return;
    }
    if (error instanceof Error && error.message.startsWith('Database is ')) {
      throw error;
    }
    throw new Error(`Unable to prove database is unused: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  parseArgs();
  await assertServiceStopped();
  assertNoSqliteSidecars();

  const guard = acquireDatabaseMaintenanceGuard(DATABASE_PATH);
  process.env[DATABASE_MAINTENANCE_TOKEN_ENV] = guard.token;
  let db: typeof import('../src/db.js') | undefined;
  try {
    await assertDatabaseUnused();
    db = await import('../src/db.js');
    const runtime = await import('../src/runtime-config.js');
    db.initDatabase({ requireCurrentSchema: true });

    const enabled = runtime.getEnabledProviders();
    if (enabled.length === 0) {
      throw new Error('No enabled Claude provider is configured');
    }
    const nonOfficial = enabled.filter(
      (provider) => provider.type !== 'official',
    );
    if (nonOfficial.length > 0) {
      throw new Error(
        `Refusing to assign Anthropic's Opus 5 ID to non-official provider(s): ${nonOfficial
          .map((provider) => provider.id)
          .join(', ')}`,
      );
    }

    const targetProfiles = TARGET_USERNAMES.map((username) => {
      const user = db!.getUserByUsername(username);
      if (!user || user.status !== 'active') {
        throw new Error(`Required active user not found: ${username}`);
      }
      return {
        username,
        userId: user.id,
        profile: db!.getOrCreateDefaultAgentProfile(user.id),
      };
    });

    const providerResults = enabled.map((provider) => {
      if (provider.anthropicModel === TARGET_MODEL) {
        return {
          providerId: provider.id,
          changed: false,
          clearedSessions: 0,
        };
      }

      const applied = db!.deleteSessionsByProviderIdAroundCommit(
        provider.id,
        undefined,
        () =>
          runtime.updateProvider(provider.id, {
            anthropicModel: TARGET_MODEL,
          }),
      );
      let auditAppended = true;
      try {
        runtime.appendClaudeConfigAudit(
          'deployment',
          'set_default_model',
          [`id:${provider.id}`, 'anthropicModel:updated'],
          {
            targetModel: TARGET_MODEL,
            clearedSessions: applied.deletedCount,
          },
        );
      } catch {
        auditAppended = false;
      }
      return {
        providerId: provider.id,
        changed: true,
        clearedSessions: applied.deletedCount,
        auditAppended,
      };
    });

    const profileResults = targetProfiles.map(
      ({ username, userId, profile }) => {
        const effortAlreadySet =
          profile.runtime_policy.reasoning.effort === TARGET_EFFORT;
        const modelAlreadyInherited = profile.model_config_id === null;
        if (effortAlreadySet && modelAlreadyInherited) {
          return {
            username,
            profileId: profile.id,
            changed: false,
            version: profile.version,
          };
        }

        const updated = db!.updateAgentProfile(profile.id, userId, {
          modelConfigId: null,
          runtimePolicy: { reasoning: { effort: TARGET_EFFORT } },
          changeSource: 'migration',
        });
        if (!updated) {
          throw new Error(
            `Failed to update default Agent profile: ${username}`,
          );
        }
        let auditAppended = true;
        try {
          runtime.appendClaudeConfigAudit(
            'deployment',
            'set_default_agent_effort',
            [`profile:${profile.id}`, 'reasoning.effort:updated'],
            {
              username,
              targetEffort: TARGET_EFFORT,
              inheritedSystemModel: true,
            },
          );
        } catch {
          auditAppended = false;
        }
        return {
          username,
          profileId: profile.id,
          changed: true,
          version: updated.version,
          auditAppended,
        };
      },
    );

    let effortSessionCleanup = 0;
    if (profileResults.some((result) => result.changed)) {
      for (const provider of enabled) {
        effortSessionCleanup += db.deleteSessionsByProviderId(
          provider.id,
        ).deletedCount;
      }
    }

    const mismatches = runtime
      .getEnabledProviders()
      .filter((provider) => provider.anthropicModel !== TARGET_MODEL);
    if (mismatches.length > 0) {
      throw new Error(
        `Enabled provider model verification failed: ${mismatches
          .map((provider) => provider.id)
          .join(', ')}`,
      );
    }
    const profileMismatches = targetProfiles.filter(({ profile }) => {
      const refreshed = db!.getAgentProfile(profile.id);
      return (
        !refreshed ||
        refreshed.model_config_id !== null ||
        refreshed.runtime_policy.reasoning.effort !== TARGET_EFFORT
      );
    });
    if (profileMismatches.length > 0) {
      throw new Error(
        `Default Agent profile verification failed: ${profileMismatches
          .map(({ username }) => username)
          .join(', ')}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          schemaVersion: db.CURRENT_SCHEMA_VERSION,
          targetModel: TARGET_MODEL,
          targetEffort: TARGET_EFFORT,
          enabledProviders: providerResults,
          defaultAgentProfiles: profileResults,
          effortSessionCleanup,
        },
        null,
        2,
      ),
    );
  } finally {
    if (db?.isDatabaseInitialized()) db.closeDatabase();
    delete process.env[DATABASE_MAINTENANCE_TOKEN_ENV];
    releaseDatabaseMaintenanceGuard(guard.lockPath, guard.token);
  }
}

void main().then(
  () => setImmediate(() => process.exit(0)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    setImmediate(() => process.exit(1));
  },
);
