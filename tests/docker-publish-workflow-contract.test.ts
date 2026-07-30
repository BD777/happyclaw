import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Docker image distribution contract', () => {
  test('main pushes publish a pinned multi-platform latest image', () => {
    const workflow = read('.github/workflows/docker-publish.yml');

    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('IMAGE_NAME: riba2534/happyclaw-agent');
    expect(workflow).toContain('type=raw,value=latest');
    expect(workflow).toContain('type=sha,format=long,prefix=git-');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('username: ${{ secrets.DOCKERHUB_USERNAME }}');
    expect(workflow).toContain('password: ${{ secrets.DOCKERHUB_TOKEN }}');
    expect(workflow).not.toContain(`${['dckr', 'pat'].join('_')}_`);

    for (const action of [
      'actions/checkout',
      'docker/setup-qemu-action',
      'docker/setup-buildx-action',
      'docker/login-action',
      'docker/metadata-action',
      'docker/build-push-action',
    ]) {
      expect(workflow).toMatch(
        new RegExp(`uses: ${action.replace('/', '\\/')}@[a-f0-9]{40}(?:\\s|$)`),
      );
    }
  });

  test('runtime defaults to the remotely published image', () => {
    expect(read('src/config.ts')).toContain(
      "'riba2534/happyclaw-agent:latest'",
    );
    const makefile = read('Makefile');
    expect(makefile).toContain(
      'CONTAINER_IMAGE ?= riba2534/happyclaw-agent:latest',
    );
    expect(makefile).toContain('docker pull "$(CONTAINER_IMAGE)"');
    expect(makefile).toContain('docker-build-local:');
  });
});
