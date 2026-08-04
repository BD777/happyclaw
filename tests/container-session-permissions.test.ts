import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-container-permissions-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: path.join(testRoot, 'data'),
    GROUPS_DIR: path.join(testRoot, 'data', 'groups'),
    STORE_DIR: path.join(testRoot, 'data', 'db'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const { buildContainerArgs, resolveContainerHostIdentity } =
  await import('../src/container-runner.js');

const mounts = [
  {
    hostPath: '/host/session',
    containerPath: '/home/node/.claude',
    readonly: false,
  },
];

function envArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-e') values.push(args[index + 1]);
  }
  return values;
}

describe('container host identity resolution', () => {
  test('uses direct ids only for rootful Linux without a user namespace', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1234,
        securityOptions: ['name=seccomp,profile=builtin'],
      }),
    ).toEqual({ mode: 'direct', uid: 1002, gid: 1234 });
  });

  test('distinguishes rootless from rootful userns-remap', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: ['name=rootless'],
      }),
    ).toEqual({ mode: 'rootless' });
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: ['name=userns'],
      }),
    ).toEqual({ mode: 'userns' });
  });

  test('does not hide a rootless daemon behind a host-root client uid', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 0,
        gid: 0,
        securityOptions: ['name=rootless'],
      }),
    ).toEqual({ mode: 'rootless' });
  });

  test('keeps host-root non-root inside the container', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 0,
        gid: 0,
        securityOptions: [],
      }),
    ).toEqual({ mode: 'host-root' });
  });

  test.each(['darwin', 'win32'] as const)(
    'preserves Docker Desktop virtualized semantics on %s',
    (platform) => {
      expect(
        resolveContainerHostIdentity({
          platform,
          uid: 501,
          gid: 20,
          securityOptions: [],
        }),
      ).toEqual({ mode: 'virtualized' });
    },
  );

  test('fails closed when daemon security options cannot be detected', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: null,
      }),
    ).toEqual({ mode: 'unknown' });
  });
});

describe('buildContainerArgs identity contract', () => {
  test('passes independently validated non-root uid and gid in direct mode', () => {
    const args = buildContainerArgs(mounts, 'identity-test', 'UTC', {
      mode: 'direct',
      uid: 1002,
      gid: 1234,
    });
    expect(envArgs(args)).toEqual(
      expect.arrayContaining([
        'HAPPYCLAW_HOST_IDENTITY_MODE=direct',
        'HAPPYCLAW_HOST_UID=1002',
        'HAPPYCLAW_HOST_GID=1234',
      ]),
    );
  });

  test.each([
    'rootless',
    'userns',
    'virtualized',
    'host-root',
    'unknown',
  ] as const)('never forwards numeric host ids in %s mode', (mode) => {
    const args = buildContainerArgs(mounts, 'identity-test', 'UTC', {
      mode,
      uid: 1002,
      gid: 1002,
    });
    expect(envArgs(args)).toContain(`HAPPYCLAW_HOST_IDENTITY_MODE=${mode}`);
    expect(
      envArgs(args).some((arg) => arg.startsWith('HAPPYCLAW_HOST_UID=')),
    ).toBe(false);
    expect(
      envArgs(args).some((arg) => arg.startsWith('HAPPYCLAW_HOST_GID=')),
    ).toBe(false);
  });
});

describe('entrypoint permission contract', () => {
  const dockerfile = fs.readFileSync(
    path.join(repoRoot, 'container', 'Dockerfile'),
    'utf8',
  );
  const entrypoint = fs.readFileSync(
    path.join(repoRoot, 'container', 'entrypoint.sh'),
    'utf8',
  );
  const helper = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions.sh'),
    'utf8',
  );
  const watcher = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions-watcher.mjs'),
    'utf8',
  );
  const fileManager = fs.readFileSync(
    path.join(repoRoot, 'src', 'file-manager.ts'),
    'utf8',
  );
  const groupQueue = fs.readFileSync(
    path.join(repoRoot, 'src', 'group-queue.ts'),
    'utf8',
  );

  test('uses fixed root-owned helpers and shadows stale malicious env values', () => {
    expect(entrypoint).toContain('source /app/session-permissions.sh');
    expect(entrypoint).toContain('happyclaw_source_runtime_env');
    expect(helper).toContain(
      '/usr/local/bin/node /app/session-permissions-watcher.mjs',
    );
    expect(helper).not.toContain('HAPPYCLAW_SESSION_PERMISSION_HELPER:-');
    expect(helper).toContain('local HAPPYCLAW_SESSION_ROOT=');
    expect(helper).toContain('local HAPPYCLAW_INTERNAL_WATCHER_PID=');
    expect(entrypoint).toContain(
      'npx tsc --outDir /tmp/dist --incremental false',
    );
    expect(entrypoint.indexOf('chown -R node:node /tmp/dist')).toBeLessThan(
      entrypoint.indexOf('ln -s /app/node_modules /tmp/dist/node_modules'),
    );
    expect(dockerfile).toContain('chown -R root:root /app/prompts');
    expect(dockerfile).toContain('find /app/prompts -type d -exec chmod 0555');
    expect(dockerfile).toContain('find /app/prompts -type f -exec chmod 0444');
  });

  test('contains no world-permission fallback', () => {
    expect(entrypoint).not.toMatch(/umask\s+0000/);
    expect(entrypoint).not.toMatch(/chmod[^\n]*a\+(?:rw|rwx|rwX)/);
    expect(helper).not.toMatch(/chmod[^\n]*a\+(?:rw|rwx|rwX)/);
    expect(helper).not.toMatch(/0?666|0?777/);
    expect(watcher).toContain('0o660');
    expect(watcher).toContain('0o2770');
    expect(watcher).not.toMatch(/fchmodSync\([^,\n]+,\s*0o(?:666|777)\b/);
    expect(fileManager).not.toContain('0o777');
    expect(groupQueue).not.toContain('0o777');
  });

  test('watcher has fixed roots, descriptor-safe paths and bounded rescans', () => {
    expect(watcher).toContain("path: '/home/node/.claude'");
    expect(watcher).toContain("path: '/home/node/.feishu-cli'");
    expect(watcher).toContain("encoding: 'buffer'");
    expect(watcher).toContain('fs.constants.O_NOFOLLOW');
    expect(watcher).toContain('/proc/self/fd/');
    expect(watcher).toContain('fs.fchownSync(fd');
    expect(watcher).toContain('fs.fchmodSync(fd');
    expect(watcher).not.toMatch(/fs\.(?:chown|chmod)Sync\(/);
    expect(watcher).not.toContain('lstatSync');
    expect(watcher).toContain('RESCAN_INTERVAL_MS = 30_000');
    expect(watcher).not.toContain('500');
  });
});

const integrationImage =
  process.env.HAPPYCLAW_CONTAINER_PERMISSION_TEST_IMAGE ??
  'riba2534/happyclaw-agent:latest';
let integrationImageAvailable = false;
try {
  execFileSync('docker', ['image', 'inspect', integrationImage], {
    stdio: 'ignore',
  });
  integrationImageAvailable = true;
} catch {
  // Unit and contract tests remain hermetic when Docker is unavailable.
}

describe.skipIf(!integrationImageAvailable)(
  'permission helper behavior in the branch image',
  () => {
    const helperPath = path.join(
      repoRoot,
      'container',
      'session-permissions.sh',
    );
    const watcherPath = path.join(
      repoRoot,
      'container',
      'session-permissions-watcher.mjs',
    );

    function runHelper(script: string, extraArgs: string[] = []): string {
      return execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/bash',
          '-v',
          `${helperPath}:/tmp/session-permissions.sh:ro`,
          '-v',
          `${watcherPath}:/app/session-permissions-watcher.mjs:ro`,
          ...extraArgs,
          integrationImage,
          '-ceu',
          `source /tmp/session-permissions.sh\n${script}`,
        ],
        { encoding: 'utf8' },
      ).trim();
    }

    test('fails closed for rootful userns-remap and unknown probes', () => {
      for (const mode of ['userns', 'unknown']) {
        expect(() =>
          runHelper(`
            HAPPYCLAW_HOST_IDENTITY_MODE=${mode}
            happyclaw_configure_node_identity
          `),
        ).toThrow();
      }
    });

    test('direct migration changes only legacy uid 1000 in fixed managed roots', () => {
      expect(
        runHelper(`
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          touch /home/node/.claude/token.json /workspace/group/canary
          chown -R 1000:1000 /home/node/.claude /workspace/group
          chmod 0777 /home/node/.claude
          chmod 0666 /home/node/.claude/token.json
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID=12347
          happyclaw_configure_node_identity
          happyclaw_migrate_direct_managed_paths
          printf '%s|%s|%s' \
            "$(stat -c '%u:%g:%a' /home/node/.claude/token.json)" \
            "$(stat -c '%u:%g' /workspace/group/canary)" \
            "$(find /home/node/.claude -maxdepth 1 -name '.happyclaw-owner-v2-*' | wc -l)"
        `),
      ).toBe('12346:12347:600|1000:1000|1');
    });

    test('runtime env cannot override root-control variables', () => {
      const envDir = fs.mkdtempSync(path.join(testRoot, 'malicious-env-'));
      fs.writeFileSync(
        path.join(envDir, 'env'),
        [
          "HAPPYCLAW_HOST_IDENTITY_MODE='unknown'",
          "HAPPYCLAW_INTERNAL_IDENTITY_MODE='pwned'",
          "HAPPYCLAW_INTERNAL_WATCHER_PID='1'",
          "HAPPYCLAW_SESSION_ROOT='/'",
          "HAPPYCLAW_SESSION_PERMISSION_HELPER='/workspace/group/evil.sh'",
          "PROJECT_ENV='kept'",
        ].join('\n'),
        { mode: 0o600 },
      );
      expect(
        runHelper(
          `
            HAPPYCLAW_HOST_IDENTITY_MODE=direct
            HAPPYCLAW_INTERNAL_IDENTITY_MODE=direct
            HAPPYCLAW_INTERNAL_WATCHER_PID=4242
            happyclaw_source_runtime_env
            printf '%s:%s:%s:%s' \
              "$HAPPYCLAW_HOST_IDENTITY_MODE" \
              "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" \
              "$HAPPYCLAW_INTERNAL_WATCHER_PID" \
              "$PROJECT_ENV"
          `,
          ['-v', `${envDir}:/workspace/env-dir:ro`],
        ),
      ).toBe('direct:direct:4242:kept');
    });

    test('one-shot bridge removes other bits without following symlinks', () => {
      expect(
        runHelper(`
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          credential=/home/node/.claude/.credentials.json
          outside=$(mktemp)
          touch "$credential"
          chmod 0600 "$credential" "$outside"
          ln -s "$outside" /home/node/.claude/outside-link
          mkdir -p $'/home/node/.claude/newline\n..'/nested
          touch $'/home/node/.claude/newline\n..'/nested/transcript.jsonl
          chmod 0600 $'/home/node/.claude/newline\n..'/nested/transcript.jsonl
          node /app/session-permissions-watcher.mjs --once
          printf '%s|%s|%s|%s' \
            "$(stat -c '%u:%g:%a' "$credential")" \
            "$(stat -c '%a' /home/node/.claude)" \
            "$(stat -c '%a' $'/home/node/.claude/newline\n..'/nested/transcript.jsonl)" \
            "$(stat -c '%a' "$outside")"
          setpriv --reuid=12345 --regid=12345 --clear-groups -- \
            test ! -r "$credential"
        `),
      ).toBe('0:1000:660|2770|660|600');
    });

    test('descriptor bridge resists file-to-symlink swaps', () => {
      expect(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            outside=$(mktemp)
            printf 'outside-canary' > "$outside"
            chown 12345:12345 "$outside"
            chmod 0640 "$outside"
            node /app/session-permissions-watcher.mjs &
            watcher_pid=$!
            for attempt in $(seq 1 200); do
              [ -e /run/happyclaw-session-watcher.ready ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            for attempt in $(seq 1 2000); do
              rm -f /home/node/.claude/race
              install -m 0600 /dev/null /home/node/.claude/race
              rm -f /home/node/.claude/race
              ln -s "$outside" /home/node/.claude/race
            done
            rm -f /home/node/.claude/race
            sleep 0.1
            kill "$watcher_pid"
            wait "$watcher_pid"
            printf '%s:%s:%s' \
              "$(stat -c '%u:%g:%a' "$outside")" \
              "$(cat "$outside")" \
              "$([ -e /run/happyclaw-session-watcher.failed ] && echo failed || echo safe)"
          `),
      ).toBe('12345:12345:640:outside-canary:safe');
    }, 30_000);

    test('live watcher repairs restrictive files and moved-in subtrees', () => {
      expect(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            node /app/session-permissions-watcher.mjs &
            watcher_pid=$!
            for attempt in $(seq 1 200); do
              [ -e /run/happyclaw-session-watcher.ready ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            install -m 0600 /dev/null /home/node/.claude/live.jsonl
            incoming=$(mktemp -d)
            mkdir -p "$incoming/deep"
            install -m 0600 /dev/null "$incoming/deep/moved.jsonl"
            mv "$incoming" /home/node/.claude/moved
            for attempt in $(seq 1 200); do
              [ "$(stat -c %a /home/node/.claude/live.jsonl)" = 660 ] && \
                [ "$(stat -c %a /home/node/.claude/moved/deep/moved.jsonl)" = 660 ] && break
              sleep 0.02
            done
            modes="$(stat -c %a /home/node/.claude/live.jsonl):$(stat -c %a /home/node/.claude/moved/deep/moved.jsonl)"
            kill "$watcher_pid"
            wait "$watcher_pid"
            printf '%s:%s' "$modes" "$(kill -0 "$watcher_pid" 2>/dev/null && echo live || echo stopped)"
          `),
      ).toBe('660:660:stopped');
    }, 20_000);

    test('normalizes a 10000-file session in bounded startup time', () => {
      const elapsed = Number(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            start=$(date +%s%N)
            node -e "const fs=require('fs'); for(let i=0;i<10000;i++) fs.writeFileSync('/home/node/.claude/f'+i,'',{mode:0o600})"
            node /app/session-permissions-watcher.mjs --once
            end=$(date +%s%N)
            printf '%s' $(((end-start)/1000000))
          `),
      );
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10_000);
    }, 30_000);
  },
);
