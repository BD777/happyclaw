#!/bin/bash
set -e

# ─── UID alignment ───
# Align container node user's UID/GID with the host process, so all files
# created inside the container are owned by the same uid as the host.
# This eliminates cross-uid permission issues on bind-mounted volumes.
HOST_UID="${HOST_UID:-1000}"
HOST_GID="${HOST_GID:-1000}"
if [ "$(id -u node)" != "$HOST_UID" ]; then
  usermod -u "$HOST_UID" -o node 2>/dev/null || true
fi
if [ "$(id -g node)" != "$HOST_GID" ]; then
  groupmod -g "$HOST_GID" -o node 2>/dev/null || true
fi
# Fix ownership of node's home dir after UID change
chown -R node:node /home/node 2>/dev/null || true

# Set permissive umask as safety net — in case any tool forces restrictive modes
umask 0000

# Fix ownership on mounted volumes (host files may have stale uid from before alignment)
chown -R node:node /home/node/.claude 2>/dev/null || true
chown -R node:node /workspace/group /workspace/global /workspace/memory /workspace/ipc 2>/dev/null || true

# Mark mounted directories as safe for git (CVE-2022-24765 ownership check).
git config --global --add safe.directory '*' 2>/dev/null || true

# Source environment variables from mounted env file
if [ -f /workspace/env-dir/env ]; then
  set -a
  source /workspace/env-dir/env
  set +a
fi

# Discover and link skills (builtin → project → user, higher priority overwrites)
# Only remove entries that conflict with mounted skills (non-symlink with same name),
# preserving any skills the agent created directly in .claude/skills/.
mkdir -p /home/node/.claude/skills
for dir in /opt/builtin-skills /workspace/external-skills /workspace/project-skills /workspace/user-skills; do
  if [ -d "$dir" ]; then
    for skill in "$dir"/*/; do
      if [ -d "$skill" ]; then
        name=$(basename "$skill")
        target="/home/node/.claude/skills/$name"
        # Remove conflicting non-symlink entry (e.g. real directory from a failed agent edit)
        if [ -e "$target" ] && [ ! -L "$target" ]; then
          rm -rf "$target" 2>/dev/null || true
        fi
        ln -sfn "$skill" "$target" 2>/dev/null || true
      fi
    done
  fi
done
chown -R node:node /home/node/.claude/skills 2>/dev/null || true

# Compile TypeScript (agent-runner source may be hot-mounted from host)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
ln -s /app/prompts /tmp/prompts
chmod -R a-w /tmp/dist

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Drop privileges and execute agent-runner as node user (now with host-aligned UID)
runuser -u node -- node /tmp/dist/index.js < /tmp/input.json
