#!/usr/bin/env bash
# Run an isolated source checkout for live UI development.
# Production stays on the globally installed package and its existing ports/data.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-start}"
WORKTREE_NAME=""
case "$ACTION" in
  -h|--help|help)
    cat <<'USAGE'
usage:
  ./dev.sh [start|stop|restart|status|setup]
  ./dev.sh <worktree-name> [start|stop|restart|status|setup]

commands:
  start    build the source server and start the isolated API + Vite (default)
  stop     stop only this checkout's development instance
  restart  stop and start only this checkout's development instance
  status   show the development PID, URLs, profile, and log
  setup    interactively save development ports and bind hosts

Each checkout/worktree keeps its own .handmux-dev directory. Re-running start
reuses an already-running instance instead of starting a duplicate.
USAGE
    exit 0
    ;;
  start|stop|restart|status|setup) ;;
  *)
    WORKTREE_NAME="$ACTION"
    ACTION="${2:-start}"
    if [[ $# -gt 2 ]] || [[ "$ACTION" != "start" && "$ACTION" != "stop" && "$ACTION" != "restart" && "$ACTION" != "status" && "$ACTION" != "setup" ]]; then
      echo "usage: $0 [start|stop|restart|status|setup] | $0 <worktree-name> [start|stop|restart|status|setup]" >&2
      exit 2
    fi
    ;;
esac

MAIN_WORKTREE="$(git -C "$SCRIPT_ROOT" worktree list --porcelain | awk '/^worktree / { print substr($0, 10); exit }')"
ROOT="$SCRIPT_ROOT"
if [[ -n "$WORKTREE_NAME" ]]; then
  if ROOT="$(git -C "$SCRIPT_ROOT" worktree list --porcelain | awk -v name="$WORKTREE_NAME" '
    /^worktree / {
      path = substr($0, 10)
      count = split(path, parts, "/")
      if (parts[count] == name) { matches++; found = path }
    }
    END {
      if (matches == 1) print found
      else if (matches > 1) exit 2
      else exit 1
    }
  ')"; then
    :
  else
    rc=$?
    if [[ $rc -eq 2 ]]; then echo "worktree name is ambiguous: $WORKTREE_NAME" >&2
    else echo "worktree not found: $WORKTREE_NAME" >&2
    fi
    exit 1
  fi
fi
if [[ ! -f "$ROOT/server/package.json" || ! -f "$ROOT/web/package.json" ]]; then
  echo "invalid Handmux worktree: $ROOT" >&2
  exit 1
fi

DEV_ROOT="${HANDMUX_DEV_ROOT:-$ROOT/.handmux-dev}"
CONFIG_FILE="$DEV_ROOT/config.env"
DEV_PROFILE="$DEV_ROOT/profile"
DEV_TMUX_TMPDIR="$DEV_ROOT/tmux"
TOKEN_FILE="$DEV_PROFILE/.handmux/token"
PID_FILE="$DEV_ROOT/dev.pid"
OWNER_START_FILE="$DEV_ROOT/dev.start"
LOCK_DIR="$DEV_ROOT/start.lock"
SERVER_LOG="$DEV_ROOT/server.log"
RUNTIME_FILE="$DEV_ROOT/runtime.env"
SERVER_START_FILE="$DEV_ROOT/server.start"
VITE_START_FILE="$DEV_ROOT/vite.start"

reject_symlink() {
  local path label
  path="$1"
  label="$2"
  if [[ -L "$path" ]]; then
    echo "refusing symlinked development $label: $path" >&2
    exit 2
  fi
}
reject_symlink "$DEV_ROOT" "root"
reject_symlink "$CONFIG_FILE" "config"
reject_symlink "$DEV_PROFILE" "profile"
reject_symlink "$DEV_TMUX_TMPDIR" "tmux directory"
reject_symlink "$PID_FILE" "PID file"
reject_symlink "$OWNER_START_FILE" "owner start file"
reject_symlink "$LOCK_DIR" "start lock"
reject_symlink "$SERVER_LOG" "server log"
reject_symlink "$RUNTIME_FILE" "runtime file"
reject_symlink "$SERVER_START_FILE" "server start file"
reject_symlink "$VITE_START_FILE" "Vite start file"

# These names are deliberately different from the environment overrides so a checked-in local config
# cannot accidentally hide a one-run command-line override.
WORKTREE_SLOT=0
if [[ "$ROOT" != "$MAIN_WORKTREE" ]]; then
  WORKTREE_SLOT="$(git -C "$SCRIPT_ROOT" worktree list --porcelain | awk -v target="$ROOT" '
    /^worktree / { path = substr($0, 10); if (path == target) { print count; exit } count++ }
  ')"
  case "$WORKTREE_SLOT" in ''|*[!0-9]*) WORKTREE_SLOT=1 ;; esac
fi
DEV_API_PORT=$((9998 + WORKTREE_SLOT))
DEV_WEB_PORT=$((9011 + WORKTREE_SLOT))
DEV_API_HOST=127.0.0.1
DEV_WEB_HOST=0.0.0.0

load_config() {
  local key value
  while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
    case "$key" in
      DEV_API_PORT) DEV_API_PORT="$value" ;;
      DEV_WEB_PORT) DEV_WEB_PORT="$value" ;;
      DEV_API_HOST) DEV_API_HOST="$value" ;;
      DEV_WEB_HOST) DEV_WEB_HOST="$value" ;;
      '') ;;
      \#*) ;;
      *) echo "unknown development config key: $key" >&2; exit 2 ;;
    esac
  done < "$CONFIG_FILE"
}
if [[ -f "$CONFIG_FILE" ]]; then
  load_config
fi
API_PORT="${HANDMUX_DEV_API_PORT:-$DEV_API_PORT}"
WEB_PORT="${HANDMUX_DEV_WEB_PORT:-$DEV_WEB_PORT}"
API_HOST="${HANDMUX_DEV_API_HOST:-$DEV_API_HOST}"
WEB_HOST="${HANDMUX_DEV_WEB_HOST:-$DEV_WEB_HOST}"

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [[ "$1" -ge 1 && "$1" -le 65535 ]]
}
validate_settings() {
  if ! valid_port "$API_PORT"; then echo "invalid development API port: $API_PORT" >&2; exit 2; fi
  if ! valid_port "$WEB_PORT"; then echo "invalid development Web port: $WEB_PORT" >&2; exit 2; fi
  if [[ "$API_PORT" == "$WEB_PORT" ]]; then echo "development API and Web ports must differ" >&2; exit 2; fi
  case "$API_HOST" in ''|*[!A-Za-z0-9:._-]*) echo "invalid development API host: $API_HOST" >&2; exit 2 ;; esac
  case "$WEB_HOST" in ''|*[!A-Za-z0-9:._-]*) echo "invalid development Web host: $WEB_HOST" >&2; exit 2 ;; esac
  case "$API_HOST" in
    127.0.0.1|localhost|::1) ;;
    *) echo "development API host must be loopback (127.0.0.1, localhost, or ::1)" >&2; exit 2 ;;
  esac
}

ensure_profile() {
  reject_symlink "$DEV_ROOT" "root"
  reject_symlink "$DEV_PROFILE" "profile"
  reject_symlink "$DEV_PROFILE/.handmux" "profile data directory"
  reject_symlink "$DEV_TMUX_TMPDIR" "tmux directory"
  reject_symlink "$TOKEN_FILE" "token"
  mkdir -p "$DEV_PROFILE/.handmux" "$DEV_TMUX_TMPDIR"
  chmod 700 "$DEV_ROOT" "$DEV_PROFILE" "$DEV_PROFILE/.handmux" "$DEV_TMUX_TMPDIR"
  if [[ ! -s "$TOKEN_FILE" ]]; then
    node --input-type=module -e "import crypto from 'node:crypto'; process.stdout.write(crypto.randomBytes(24).toString('base64url') + '\\n')" > "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  DEV_TOKEN="$(cat "$TOKEN_FILE")"
}

setup_dev() {
  if [[ ! -t 0 ]]; then
    echo "development setup requires an interactive terminal" >&2
    exit 2
  fi
  mkdir -p "$DEV_ROOT"
  local value
  printf '开发 API 端口 [%s]: ' "$DEV_API_PORT"
  IFS= read -r value || exit 130
  [[ -z "$value" ]] || DEV_API_PORT="$value"
  printf '开发 Web 端口 [%s]: ' "$DEV_WEB_PORT"
  IFS= read -r value || exit 130
  [[ -z "$value" ]] || DEV_WEB_PORT="$value"
  printf '开发 API host [%s]: ' "$DEV_API_HOST"
  IFS= read -r value || exit 130
  [[ -z "$value" ]] || DEV_API_HOST="$value"
  printf '开发 Web host [%s]: ' "$DEV_WEB_HOST"
  IFS= read -r value || exit 130
  [[ -z "$value" ]] || DEV_WEB_HOST="$value"
  API_PORT="$DEV_API_PORT"
  WEB_PORT="$DEV_WEB_PORT"
  API_HOST="$DEV_API_HOST"
  WEB_HOST="$DEV_WEB_HOST"
  validate_settings
  mkdir -p "$DEV_ROOT"
  {
    printf '%s=%q\n' DEV_API_PORT "$DEV_API_PORT"
    printf '%s=%q\n' DEV_WEB_PORT "$DEV_WEB_PORT"
    printf '%s=%q\n' DEV_API_HOST "$DEV_API_HOST"
    printf '%s=%q\n' DEV_WEB_HOST "$DEV_WEB_HOST"
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  ensure_profile
  echo "开发配置已保存：$CONFIG_FILE"
  echo "开发 Token 已保存：$TOKEN_FILE"
  echo "启动：$0${WORKTREE_NAME:+ $WORKTREE_NAME}"
}

read_pid() {
  [[ -s "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$pid"
}
is_alive() { kill -0 "$1" 2>/dev/null; }
process_start() {
  ps -p "$1" -o lstart= 2>/dev/null | sed -e 's/^ *//' -e 's/ *$//'
}
is_owned_pid() {
  local pid expected actual
  pid="$1"
  [[ -s "$OWNER_START_FILE" ]] || return 1
  expected="$(cat "$OWNER_START_FILE")"
  actual="$(process_start "$pid")"
  [[ -n "$expected" && "$expected" == "$actual" ]]
}
is_dev_alive() { is_alive "$1" && is_owned_pid "$1"; }
load_runtime() {
  RUNTIME_API_PORT=""
  RUNTIME_WEB_PORT=""
  RUNTIME_API_HOST=""
  RUNTIME_WEB_HOST=""
  RUNTIME_SERVER_PID=""
  RUNTIME_VITE_PID=""
  [[ -f "$RUNTIME_FILE" ]] || return 0
  local key value
  while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
    case "$key" in
      RUNTIME_API_PORT) RUNTIME_API_PORT="$value" ;;
      RUNTIME_WEB_PORT) RUNTIME_WEB_PORT="$value" ;;
      RUNTIME_API_HOST) RUNTIME_API_HOST="$value" ;;
      RUNTIME_WEB_HOST) RUNTIME_WEB_HOST="$value" ;;
      RUNTIME_SERVER_PID) RUNTIME_SERVER_PID="$value" ;;
      RUNTIME_VITE_PID) RUNTIME_VITE_PID="$value" ;;
      '') ;;
      *) echo "unknown development runtime key: $key" >&2; exit 2 ;;
    esac
  done < "$RUNTIME_FILE"
}
write_runtime() {
  {
    printf '%s=%s\n' RUNTIME_API_PORT "$API_PORT"
    printf '%s=%s\n' RUNTIME_WEB_PORT "$WEB_PORT"
    printf '%s=%s\n' RUNTIME_API_HOST "$API_HOST"
    printf '%s=%s\n' RUNTIME_WEB_HOST "$WEB_HOST"
    printf '%s=%s\n' RUNTIME_SERVER_PID "${SERVER_PID:-}"
    printf '%s=%s\n' RUNTIME_VITE_PID "${VITE_PID:-}"
  } > "$RUNTIME_FILE"
  chmod 600 "$RUNTIME_FILE"
}
cleanup_orphaned_children() {
  load_runtime
  local kind pid start current start_file i alive
  for kind in server vite; do
    if [[ "$kind" == server ]]; then pid="$RUNTIME_SERVER_PID"; start_file="$SERVER_START_FILE"
    else pid="$RUNTIME_VITE_PID"; start_file="$VITE_START_FILE"; fi
    case "$pid" in ''|0|*[!0-9]*) continue ;; esac
    [[ -s "$start_file" ]] || continue
    start="$(cat "$start_file")"
    current="$(process_start "$pid")"
    [[ -n "$start" && "$start" == "$current" ]] || continue
    kill "$pid" 2>/dev/null || true
  done
  i=0
  while [[ $i -lt 50 ]]; do
    alive=0
    for kind in server vite; do
      if [[ "$kind" == server ]]; then pid="$RUNTIME_SERVER_PID"; start_file="$SERVER_START_FILE"
      else pid="$RUNTIME_VITE_PID"; start_file="$VITE_START_FILE"; fi
      case "$pid" in ''|0|*[!0-9]*) continue ;; esac
      [[ -s "$start_file" ]] || continue
      start="$(cat "$start_file")"
      current="$(process_start "$pid")"
      if [[ -n "$start" && "$start" == "$current" ]] && is_alive "$pid"; then alive=1; fi
    done
    [[ "$alive" == 0 ]] && break
    sleep 0.1
    i=$((i + 1))
  done
}

print_status() {
  local pid shown_api_port shown_web_port shown_api_host shown_web_host
  shown_api_port="$API_PORT"
  shown_web_port="$WEB_PORT"
  shown_api_host="$API_HOST"
  shown_web_host="$WEB_HOST"
  if pid="$(read_pid)" && is_dev_alive "$pid"; then
    load_runtime
    shown_api_port="${RUNTIME_API_PORT:-$shown_api_port}"
    shown_web_port="${RUNTIME_WEB_PORT:-$shown_web_port}"
    shown_api_host="${RUNTIME_API_HOST:-$shown_api_host}"
    shown_web_host="${RUNTIME_WEB_HOST:-$shown_web_host}"
    echo "development running (pid $pid)"
    echo "  web:     http://localhost:$shown_web_port"
    echo "  api:     http://$shown_api_host:$shown_api_port"
    echo "  profile: $DEV_PROFILE"
    echo "  log:     $SERVER_LOG"
    return 0
  fi
  cleanup_orphaned_children
  rm -f "$PID_FILE"
  rm -f "$OWNER_START_FILE"
  rm -f "$RUNTIME_FILE"
  rm -f "$SERVER_START_FILE" "$VITE_START_FILE"
  rm -rf "$LOCK_DIR"
  echo "development stopped"
  return 1
}

prepare_worktree_dependencies() {
  TEMP_DEP_LINKS=()
  [[ "$ROOT" == "$MAIN_WORKTREE" ]] && return 0
  local package_dir target source selected_lock source_lock
  for package_dir in server web; do
    target="$ROOT/$package_dir/node_modules"
    source="$MAIN_WORKTREE/$package_dir/node_modules"
    selected_lock="$ROOT/$package_dir/package-lock.json"
    source_lock="$MAIN_WORKTREE/$package_dir/package-lock.json"
    if [[ -e "$target" && ! -L "$target" ]]; then continue; fi
    if [[ ! -d "$source" ]]; then
      echo "missing dependencies for worktree: $source" >&2
      echo "run npm ci in $MAIN_WORKTREE/$package_dir or $ROOT/$package_dir" >&2
      exit 1
    fi
    if [[ ! -f "$selected_lock" || ! -f "$source_lock" ]] || ! cmp -s "$selected_lock" "$source_lock"; then
      echo "worktree dependency lock differs: $package_dir/package-lock.json" >&2
      echo "run npm ci in $ROOT/$package_dir" >&2
      exit 1
    fi
    if [[ -L "$target" ]]; then
      local target_real source_real
      target_real="$(cd "$target" 2>/dev/null && pwd -P || true)"
      source_real="$(cd "$source" 2>/dev/null && pwd -P || true)"
      if [[ "$target_real" != "$source_real" ]]; then
        echo "worktree dependency symlink points outside the main checkout: $target" >&2
        exit 1
      fi
      TEMP_DEP_LINKS+=("$target")
      continue
    fi
    ln -s "$source" "$target"
    TEMP_DEP_LINKS+=("$target")
  done
}

SERVER_PID=""
VITE_PID=""
CLEANED=0
cleanup() {
  [[ "$CLEANED" == 1 ]] && return 0
  CLEANED=1
  for pid in "$VITE_PID" "$SERVER_PID"; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
  done
  for pid in "$VITE_PID" "$SERVER_PID"; do
    [[ -n "$pid" ]] || continue
    wait "$pid" 2>/dev/null || true
  done
  for link in "${TEMP_DEP_LINKS[@]-}"; do
    [[ -L "$link" ]] && rm -f "$link"
  done
  rm -f "$PID_FILE"
  rm -f "$OWNER_START_FILE"
  # Keep child PID/start-time records until status/start confirms that an
  # interrupted owner left no process behind, so the next invocation can reap
  # orphaned API/Vite children instead of losing their identities.
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

stop_dev() {
  local pid i
  if ! pid="$(read_pid)" || ! is_dev_alive "$pid"; then
    cleanup_orphaned_children
    rm -f "$PID_FILE"
    rm -f "$OWNER_START_FILE"
    rm -f "$RUNTIME_FILE"
    rm -f "$SERVER_START_FILE" "$VITE_START_FILE"
    rm -rf "$LOCK_DIR"
    echo "development already stopped"
    return 0
  fi
  echo "stopping development (pid $pid)…"
  kill "$pid" 2>/dev/null || true
  i=0
  while is_dev_alive "$pid" && [[ $i -lt 50 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  if is_dev_alive "$pid"; then
    echo "development did not stop; inspect $SERVER_LOG" >&2
    return 1
  fi
  rm -f "$PID_FILE"
  rm -f "$OWNER_START_FILE"
  rm -f "$RUNTIME_FILE"
  rm -f "$SERVER_START_FILE" "$VITE_START_FILE"
  rm -rf "$LOCK_DIR"
  echo "development stopped"
}

start_dev() {
  validate_settings
  if print_status; then
    echo "already running; source changes use Vite HMR"
    return 0
  fi
  if [[ -e "$LOCK_DIR" ]]; then
    local lock_pid
    lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ -n "$lock_pid" ]] && is_dev_alive "$lock_pid"; then
      echo "development is starting (pid $lock_pid); try status again shortly"
      return 0
    fi
    rm -rf "$LOCK_DIR"
  fi
  mkdir -p "$DEV_ROOT"
  mkdir "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  printf '%s\n' "$$" > "$PID_FILE"
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT TERM
  owner_start="$(process_start "$$")"
  if [[ -z "$owner_start" ]]; then
    echo "cannot determine development process start time" >&2
    exit 1
  fi
  printf '%s\n' "$owner_start" > "$OWNER_START_FILE"
  rm -f "$SERVER_START_FILE" "$VITE_START_FILE"
  prepare_worktree_dependencies
  ensure_profile
  SERVER_PID=""
  VITE_PID=""
  write_runtime

  echo "==> building development server from $ROOT"
  ( cd "$ROOT/server" && npm run build:server )

  echo "==> starting isolated API on $API_HOST:$API_PORT"
  (
    export HOME="$DEV_PROFILE"
    export TMUX_TMPDIR="$DEV_TMUX_TMPDIR"
    export HANDMUX_HOST="$API_HOST"
    export HANDMUX_PORT="$API_PORT"
    export HANDMUX_TOKEN="$DEV_TOKEN"
    export HANDMUX_APP_NAME=dev
    export CLAUDE_STATE_FILE="$DEV_PROFILE/.handmux/claude-state.json"
    export CODEBUDDY_STATE_FILE="$DEV_PROFILE/.handmux/codebuddy-state.json"
    export PUSH_STORE="$DEV_PROFILE/.handmux/push-subs.json"
    export PREVIEW_STORE="$DEV_PROFILE/.handmux/previews.json"
    export NOTIF_DIR="$DEV_PROFILE/.handmux/notifications"
    export CODEX_HOME="$DEV_PROFILE/.codex"
    export HANDMUX_EXTRA_ROOTS="$ROOT"
    unset TMUX TMUX_PANE
    unset HANDMUX_STATE
    exec node "$ROOT/server/dist/src/server.js"
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  server_start="$(process_start "$SERVER_PID")"
  [[ -n "$server_start" ]] && printf '%s\n' "$server_start" > "$SERVER_START_FILE"
  write_runtime

  echo "==> starting Vite on $WEB_HOST:$WEB_PORT"
  (
    export HANDMUX_APP_NAME=dev
    export HANDMUX_DEV_API_PORT="$API_PORT"
    export HANDMUX_DEV_WEB_PORT="$WEB_PORT"
    export HANDMUX_DEV_API_HOST="$API_HOST"
    cd "$ROOT/web"
    exec "$ROOT/web/node_modules/.bin/vite" --host "$WEB_HOST" --port "$WEB_PORT"
  ) &
  VITE_PID=$!
  vite_start="$(process_start "$VITE_PID")"
  [[ -n "$vite_start" ]] && printf '%s\n' "$vite_start" > "$VITE_START_FILE"
  write_runtime

  echo "==> development URL: http://localhost:$WEB_PORT"
  echo "==> development token: $DEV_TOKEN"
  echo "==> isolated profile: $DEV_PROFILE"
  echo "==> server log: $SERVER_LOG"
  echo "==> press Ctrl-C to stop development only"

  while is_alive "$SERVER_PID" && is_alive "$VITE_PID"; do sleep 1; done
  if ! is_alive "$SERVER_PID"; then echo "development server exited; see $SERVER_LOG" >&2
  else echo "Vite exited" >&2
  fi
  return 1
}

case "$ACTION" in
  setup) setup_dev ;;
  status) print_status || true ;;
  stop) stop_dev ;;
  restart) stop_dev; start_dev ;;
  start) start_dev ;;
esac
