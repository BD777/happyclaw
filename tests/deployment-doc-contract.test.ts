import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('Linux production deployment contract', () => {
  test('links the executable runbook and preserves runtime data', () => {
    const agents = read('AGENTS.md');
    const deployment = read('DEPLOYMENT.md');

    expect(agents).toContain('[DEPLOYMENT.md](DEPLOYMENT.md)');
    expect(deployment).toContain('/home/windeng/workspace/happyclaw');
    expect(deployment).toContain('pm2 restart happyclaw');
    expect(deployment).toContain('happyclaw.strangeoutlier.com');
    expect(deployment).toContain('/etc/nginx/conf.d/happyclaw.conf');
    expect(agents).toContain('opted out of deployment backups');
    expect(deployment).toContain('不得运行 `make backup`');
    expect(deployment).toContain('HAPPYCLAW_SKIP_MIGRATION_BACKUP=1');
    expect(deployment).not.toContain(
      'BACKUP_DIR="$HOME/happyclaw-deploy-backups" make backup',
    );
    expect(deployment).not.toContain('env-before-$HAPPYCLAW_EXPECTED_SHA');
    expect(deployment).toContain('npm run build:all');
    expect(deployment).toContain('pm2 stop happyclaw');
    expect(deployment).toContain('scripts/set-default-opus5.ts --apply');
    expect(deployment).toContain('/api/health');
    expect(deployment).toContain('/api/config/appearance/public');
    expect(deployment).toContain('HAPPYCLAW_PREVIOUS_SHA');
    expect(deployment).not.toContain('ssh macmini');
    expect(deployment).not.toContain('launchctl');
    expect(agents).not.toContain('Mac mini');
    expect(deployment).not.toMatch(
      /^\s*(?:git clean|git reset --hard|make reset-init)\b/m,
    );
  });
});
