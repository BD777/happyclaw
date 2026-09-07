#!/usr/bin/env bash
# Build an immutable runner overlay when hosted image publication is unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
agent_base_ref="${1:?Usage: build-local-agent-image.sh <base-image@sha256:digest>}"
[[ "$agent_base_ref" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Base must be pinned by digest' >&2; exit 1; }
test -z "$(git status --porcelain --untracked-files=no)" || { echo 'Commit tracked changes first' >&2; exit 1; }
agent_build_sha="$(git rev-parse HEAD)"
agent_build_tag="happyclaw-agent:git-${agent_build_sha}"
npm --prefix container/agent-runner run build
agent_build_context="$(mktemp -d)"
trap 'test -n "$agent_build_context" && find "$agent_build_context" -depth -delete' EXIT
cp -R container/agent-runner/dist "$agent_build_context/dist"
cp -R container/agent-runner/prompts "$agent_build_context/prompts"
# Reuse only lock-matching runtime packages. The upstream security updates
# are pure-JS packages and may be replaced from the freshly npm-ci-installed
# tree. Any broader dependency drift requires a full image build.
node --input-type=module - "$agent_base_ref" "$agent_build_context" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const expected = JSON.parse(fs.readFileSync('container/agent-runner/package-lock.json','utf8')).packages;
const installed = JSON.parse(execFileSync('docker',['run','--rm','--entrypoint','cat',process.argv[2],'/opt/happyclaw-agent/node_modules/.package-lock.json'],{encoding:'utf8'}));
const local = JSON.parse(fs.readFileSync('container/agent-runner/node_modules/.package-lock.json','utf8')).packages;
const patches = [];
for (const [name, pkg] of Object.entries(installed.packages)) {
  if (pkg.dev) continue;
  if (!expected[name]) throw new Error(`Unexpected base package: ${name}`);
  if (pkg.version !== expected[name].version || pkg.integrity !== expected[name].integrity) {
    if (!['node_modules/fast-uri','node_modules/qs','node_modules/side-channel'].includes(name)) throw new Error(`Full image build required: ${name}`);
    if (local[name]?.integrity !== expected[name].integrity || local[name]?.version !== expected[name].version) throw new Error(`Run npm ci first: ${name}`);
    fs.cpSync(path.join('container/agent-runner',name),path.join(process.argv[3],name),{recursive:true});
    installed.packages[name] = local[name];
    patches.push(name);
  }
}
for (const [name,pkg] of Object.entries(local)) {
  // npm may retain metadata for optional binaries excluded on this host.
  if (pkg.optional && !fs.existsSync(path.join('container/agent-runner',name))) continue;
  if (!pkg.dev && !installed.packages[name]) throw new Error(`Full image build required for new dependency: ${name}`);
}
fs.mkdirSync(path.join(process.argv[3],'node_modules'),{recursive:true});
fs.writeFileSync(path.join(process.argv[3],'node_modules/.package-lock.json'),JSON.stringify(installed));
fs.writeFileSync(path.join(process.argv[3],'dependency-patches.json'),JSON.stringify(patches));
console.log(JSON.stringify({dependencyPatches:patches}));
JS
cp container/entrypoint.sh container/session-generated-paths.mjs container/write-tool-audit.sh "$agent_build_context/"
# Normalize modes inside the image; a restrictive host umask must not make the
# non-root production runner unreadable (the September 4 incident).
cat > "$agent_build_context/Dockerfile" <<'DOCKER'
ARG BASE
FROM ${BASE}
USER root
ARG REVISION
LABEL org.opencontainers.image.revision=${REVISION}
COPY dependency-patches.json /tmp/happyclaw-dependency-patches.json
RUN node -e 'const fs=require("fs");for(const p of JSON.parse(fs.readFileSync("/tmp/happyclaw-dependency-patches.json")))fs.rmSync("/opt/happyclaw-agent/"+p,{recursive:true,force:true})'
COPY node_modules /opt/happyclaw-agent/node_modules
COPY dist /opt/happyclaw-agent/dist
COPY prompts /opt/happyclaw-agent/prompts
COPY entrypoint.sh session-generated-paths.mjs write-tool-audit.sh /app/
RUN find /opt/happyclaw-agent/dist /opt/happyclaw-agent/prompts -type d -exec chmod 0555 {} + \
 && find /opt/happyclaw-agent/dist /opt/happyclaw-agent/prompts -type f -exec chmod 0444 {} + \
 && find /opt/happyclaw-agent/node_modules/fast-uri /opt/happyclaw-agent/node_modules/qs /opt/happyclaw-agent/node_modules/side-channel -type d -exec chmod 0555 {} + \
 && find /opt/happyclaw-agent/node_modules/fast-uri /opt/happyclaw-agent/node_modules/qs /opt/happyclaw-agent/node_modules/side-channel -type f -exec chmod 0444 {} + \
 && chmod 0555 /app/entrypoint.sh /app/write-tool-audit.sh \
 && chmod 0444 /app/session-generated-paths.mjs
DOCKER
docker build --build-arg "BASE=$agent_base_ref" --build-arg "REVISION=$agent_build_sha" --tag "$agent_build_tag" "$agent_build_context"
./scripts/smoke-agent-image.sh "$agent_build_tag" amd64
docker image inspect "$agent_build_tag" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
