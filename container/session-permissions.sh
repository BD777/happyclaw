#!/bin/bash

# Root-side container identity helpers. This file is copied into the image and
# sourced from the fixed /app/session-permissions.sh path by entrypoint.sh.
# Nothing here accepts a path or helper override from the runtime env.

HAPPYCLAW_INTERNAL_IDENTITY_MODE=unconfigured
HAPPYCLAW_INTERNAL_RUNTIME_UID=
HAPPYCLAW_INTERNAL_RUNTIME_GID=
HAPPYCLAW_INTERNAL_WATCHER_PID=

happyclaw_permission_error() {
  printf 'happyclaw: %s\n' "$1" >&2
}

happyclaw_permission_fatal() {
  happyclaw_permission_error "$1"
  return 1
}

happyclaw_valid_nonroot_id() {
  local value="$1"
  case "$value" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null && [ "$value" -le 2147483647 ] 2>/dev/null
}

happyclaw_write_runtime_ids() {
  local runtime_user="$1"
  local runtime_uid="$2"
  local runtime_gid="$3"
  local passwd_file=/etc/passwd
  local temporary

  temporary=$(mktemp /etc/happyclaw-passwd.XXXXXX) || return 1
  if ! awk -F: -v OFS=: -v user="$runtime_user" \
    -v uid="$runtime_uid" -v gid="$runtime_gid" '
      $1 == user { $3 = uid; $4 = gid; found = 1 }
      { print }
      END { if (!found) exit 42 }
    ' "$passwd_file" > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0644 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$passwd_file"
}

happyclaw_configure_node_identity() {
  local runtime_user=node
  local mode="${HAPPYCLAW_HOST_IDENTITY_MODE:-unknown}"
  local requested_uid="${HAPPYCLAW_HOST_UID:-}"
  local requested_gid="${HAPPYCLAW_HOST_GID:-}"
  local current_uid current_gid existing_name target_gid

  current_uid=$(id -u "$runtime_user") || return 1
  current_gid=$(id -g "$runtime_user") || return 1
  case "$mode" in
    direct)
      if ! happyclaw_valid_nonroot_id "$requested_uid"; then
        happyclaw_permission_fatal \
          "direct identity mode requires a validated non-root host uid"
        return 1
      fi
      target_gid="$current_gid"
      if [ -n "$requested_gid" ]; then
        if ! happyclaw_valid_nonroot_id "$requested_gid"; then
          happyclaw_permission_fatal \
            "direct identity mode received an invalid host gid"
          return 1
        fi
        target_gid="$requested_gid"
      fi
      if [ "$requested_uid" != "$current_uid" ]; then
        existing_name=$(getent passwd "$requested_uid" | cut -d: -f1 || true)
        if [ -n "$existing_name" ]; then
          happyclaw_permission_fatal \
            "host uid $requested_uid collides with image account $existing_name"
          return 1
        fi
      fi
      if [ "$target_gid" != "$current_gid" ] && \
        ! groupmod --non-unique --gid "$target_gid" "$runtime_user"; then
        happyclaw_permission_fatal \
          "could not align the node group with host gid $target_gid"
        return 1
      fi
      if [ "$requested_uid" != "$current_uid" ] || [ "$target_gid" != "$current_gid" ]; then
        if ! happyclaw_write_runtime_ids "$runtime_user" "$requested_uid" "$target_gid"; then
          happyclaw_permission_fatal "could not update the node passwd identity"
          return 1
        fi
      fi
      HAPPYCLAW_INTERNAL_IDENTITY_MODE=direct
      HAPPYCLAW_INTERNAL_RUNTIME_UID="$requested_uid"
      HAPPYCLAW_INTERNAL_RUNTIME_GID="$target_gid"
      chown "$requested_uid:$target_gid" /home/node
      ;;
    rootless)
      # Rootless Docker maps container uid 0 to the daemon/service uid. The
      # mapping is verified against host-created bind roots before it is used.
      HAPPYCLAW_INTERNAL_IDENTITY_MODE=rootless
      HAPPYCLAW_INTERNAL_RUNTIME_UID="$current_uid"
      HAPPYCLAW_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    host-root)
      # Host uid 0 can read node-owned 0600 files. Keep the agent non-root and
      # normalize only explicitly authorized writable mounts.
      HAPPYCLAW_INTERNAL_IDENTITY_MODE=host-root
      HAPPYCLAW_INTERNAL_RUNTIME_UID="$current_uid"
      HAPPYCLAW_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    virtualized)
      # Preserve Docker Desktop's established node-owned bind semantics, but
      # never grant group/other access. Real Mac/Windows smoke is required.
      HAPPYCLAW_INTERNAL_IDENTITY_MODE=virtualized
      HAPPYCLAW_INTERNAL_RUNTIME_UID="$current_uid"
      HAPPYCLAW_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    userns)
      happyclaw_permission_fatal \
        "rootful userns-remap has no safe host/session identity bridge; refusing to start"
      return 1
      ;;
    unknown | *)
      happyclaw_permission_fatal \
        "container identity could not be determined safely; refusing to start"
      return 1
      ;;
  esac
  export HAPPYCLAW_INTERNAL_IDENTITY_MODE
  export HAPPYCLAW_INTERNAL_RUNTIME_UID HAPPYCLAW_INTERNAL_RUNTIME_GID
}

happyclaw_normalize_node_owned_tree() {
  local mounted_path="$1"
  [ -e "$mounted_path" ] || return 0
  chown -R node:node "$mounted_path"
  find "$mounted_path" -xdev -type d -exec chmod u+rwx,go-rwx {} +
  find "$mounted_path" -xdev -type f -exec chmod go-rwx {} +
}

happyclaw_prepare_mounted_path() {
  local mounted_path="$1"
  [ -e "$mounted_path" ] || return 0
  case "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" in
    direct)
      chown "$HAPPYCLAW_INTERNAL_RUNTIME_UID:$HAPPYCLAW_INTERNAL_RUNTIME_GID" \
        "$mounted_path"
      ;;
    rootless)
      # The watcher performs one owner/group/mode transaction before node runs.
      ;;
    host-root | virtualized)
      happyclaw_normalize_node_owned_tree "$mounted_path"
      ;;
    *)
      happyclaw_permission_fatal "mount preparation attempted before safe identity setup"
      return 1
      ;;
  esac
}

happyclaw_prepare_generated_path() {
  local generated_path="$1"
  [ -e "$generated_path" ] || return 0
  case "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" in
    direct | host-root | virtualized) chown -R node:node "$generated_path" ;;
    rootless) ;;
    *) return 1 ;;
  esac
}

happyclaw_source_runtime_env() {
  # Shadow every root-control variable while sourcing the host-generated env.
  # Ordinary runtime variables intentionally persist as globals.
  local HAPPYCLAW_HOST_IDENTITY_MODE="$HAPPYCLAW_HOST_IDENTITY_MODE"
  local HAPPYCLAW_HOST_UID="${HAPPYCLAW_HOST_UID:-}"
  local HAPPYCLAW_HOST_GID="${HAPPYCLAW_HOST_GID:-}"
  local HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=
  local HAPPYCLAW_MOUNT_PREPARE_MODE=
  local HAPPYCLAW_RUNTIME_USER=
  local HAPPYCLAW_SESSION_ROOT=
  local HAPPYCLAW_SESSION_PERMISSION_HELPER=
  local HAPPYCLAW_SESSION_PERMISSION_INTERVAL=
  local HAPPYCLAW_SESSION_PERMISSION_PID=
  local HAPPYCLAW_INTERNAL_IDENTITY_MODE="$HAPPYCLAW_INTERNAL_IDENTITY_MODE"
  local HAPPYCLAW_INTERNAL_RUNTIME_UID="$HAPPYCLAW_INTERNAL_RUNTIME_UID"
  local HAPPYCLAW_INTERNAL_RUNTIME_GID="$HAPPYCLAW_INTERNAL_RUNTIME_GID"
  local HAPPYCLAW_INTERNAL_WATCHER_PID="$HAPPYCLAW_INTERNAL_WATCHER_PID"
  if [ -f /workspace/env-dir/env ]; then
    set -a
    # shellcheck disable=SC1091 -- fixed read-only bind generated by the host.
    source /workspace/env-dir/env
    set +a
  fi
}

happyclaw_migrate_direct_managed_paths() {
  [ "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" = direct ] || return 0
  # The fixed-root descriptor walker changes only legacy uid 1000 ownership
  # and creates its marker through the already-open root fd.
  /usr/local/bin/node /app/session-permissions-watcher.mjs --migrate-direct
}

happyclaw_verify_rootless_bridge() {
  local mounted_path current_uid
  [ "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" = rootless ] || return 0
  for mounted_path in \
    /home/node/.claude /workspace/group /workspace/ipc /workspace/extra; do
    [ -e "$mounted_path" ] || continue
    current_uid=$(stat -c %u "$mounted_path") || return 1
    if [ "$current_uid" != 0 ]; then
      happyclaw_permission_fatal \
        "rootless bind root $mounted_path is not mapped to container root (saw uid $current_uid)"
      return 1
    fi
  done
}

happyclaw_start_session_permission_watcher() {
  local attempt
  [ "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" = rootless ] || return 0
  happyclaw_verify_rootless_bridge || return 1
  rm -f -- /run/happyclaw-session-watcher.ready /run/happyclaw-session-watcher.failed
  /usr/local/bin/node /app/session-permissions-watcher.mjs &
  HAPPYCLAW_INTERNAL_WATCHER_PID=$!
  for ((attempt = 0; attempt < 500; attempt++)); do
    if [ -e /run/happyclaw-session-watcher.ready ]; then
      export HAPPYCLAW_INTERNAL_WATCHER_PID
      return 0
    fi
    if [ -e /run/happyclaw-session-watcher.failed ] || \
      ! kill -0 "$HAPPYCLAW_INTERNAL_WATCHER_PID" 2>/dev/null; then
      wait "$HAPPYCLAW_INTERNAL_WATCHER_PID" 2>/dev/null || true
      HAPPYCLAW_INTERNAL_WATCHER_PID=
      happyclaw_permission_fatal "rootless permission watcher failed before readiness"
      return 1
    fi
    sleep 0.02
  done
  kill "$HAPPYCLAW_INTERNAL_WATCHER_PID" 2>/dev/null || true
  wait "$HAPPYCLAW_INTERNAL_WATCHER_PID" 2>/dev/null || true
  HAPPYCLAW_INTERNAL_WATCHER_PID=
  happyclaw_permission_fatal "rootless permission watcher readiness timed out"
}

happyclaw_stop_session_permission_watcher() {
  if [ -n "$HAPPYCLAW_INTERNAL_WATCHER_PID" ]; then
    kill "$HAPPYCLAW_INTERNAL_WATCHER_PID" 2>/dev/null || true
    wait "$HAPPYCLAW_INTERNAL_WATCHER_PID" 2>/dev/null || true
    HAPPYCLAW_INTERNAL_WATCHER_PID=
  fi
  if [ "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" = rootless ]; then
    /usr/local/bin/node /app/session-permissions-watcher.mjs --once
  fi
}
