#!/usr/bin/env bash
# Build an immutable runner overlay when hosted image publication is unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
agent_base_ref="${1:?Usage: build-local-agent-image.sh <base-image@sha256:digest>}"
[[ "$agent_base_ref" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Base must be pinned by digest' >&2; exit 1; }
test -z "$(git status --porcelain --untracked-files=no)" || { echo 'Commit tracked changes first' >&2; exit 1; }
agent_build_sha="$(git rev-parse HEAD)"
agent_build_tag="happyclaw-agent:git-${agent_build_sha}"
# Inspect npm's installed lock metadata without exposing runtime configuration.
node --input-type=module - "$agent_base_ref" <<'JS'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const expected = JSON.parse(fs.readFileSync('container/agent-runner/package-lock.json','utf8')).packages;
const installed = JSON.parse(execFileSync('docker',['run','--rm','--entrypoint','cat',process.argv[2],'/opt/happyclaw-agent/node_modules/.package-lock.json'],{encoding:'utf8'})).packages;
for (const [name, pkg] of Object.entries(installed)) {
  if (pkg.dev) continue;
  if (!expected[name] || pkg.version !== expected[name].version || pkg.integrity !== expected[name].integrity) {
    throw new Error(`Base runtime dependency differs from committed lock: ${name}`);
  }
}
for (const name of Object.keys(JSON.parse(fs.readFileSync('container/agent-runner/package.json','utf8')).dependencies)) {
  if (!installed[`node_modules/${name}`]) throw new Error(`Missing runtime dependency: ${name}`);
}
JS
npm --prefix container/agent-runner run build
agent_build_context="$(mktemp -d)"
trap 'test -n "$agent_build_context" && find "$agent_build_context" -depth -delete' EXIT
cp -R container/agent-runner/dist "$agent_build_context/dist"
cp -R container/agent-runner/prompts "$agent_build_context/prompts"
cp container/entrypoint.sh container/session-generated-paths.mjs container/write-tool-audit.sh "$agent_build_context/"
# Normalize modes inside the image; a restrictive host umask must not make the
# non-root production runner unreadable (the September 4 incident).
cat > "$agent_build_context/Dockerfile" <<'DOCKER'
ARG BASE
FROM ${BASE}
USER root
ARG REVISION
LABEL org.opencontainers.image.revision=${REVISION}
COPY dist /opt/happyclaw-agent/dist
COPY prompts /opt/happyclaw-agent/prompts
COPY entrypoint.sh session-generated-paths.mjs write-tool-audit.sh /app/
RUN find /opt/happyclaw-agent/dist /opt/happyclaw-agent/prompts -type d -exec chmod 0555 {} + \
 && find /opt/happyclaw-agent/dist /opt/happyclaw-agent/prompts -type f -exec chmod 0444 {} + \
 && chmod 0555 /app/entrypoint.sh /app/write-tool-audit.sh \
 && chmod 0444 /app/session-generated-paths.mjs
DOCKER
docker build --build-arg "BASE=$agent_base_ref" --build-arg "REVISION=$agent_build_sha" --tag "$agent_build_tag" "$agent_build_context"
./scripts/smoke-agent-image.sh "$agent_build_tag" amd64
docker image inspect "$agent_build_tag" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
