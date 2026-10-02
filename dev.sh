#!/usr/bin/env bash
# Build and run the source checkout through the same packaged CLI as production.
# The only difference is the isolated HOME/profile, tmux directory and port.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_WORKTREE="$(git -C "$SCRIPT_ROOT" worktree list --porcelain | awk '/^worktree / { print substr($0, 10); exit }')"
WORKTREE_NAME=""
ACTION=""
CLI_ARGS=()

is_control_action() {
  case "${1:-}" in
    deploy|start|stop|restart|status|cli|help|-h|--help) return 0 ;;
    *) return 1 ;;
  esac
}
is_registered_worktree() {
  local name="$1" path count=0
  while IFS= read -r path; do
    [[ "$(basename "$path")" == "$name" ]] && count=$((count + 1))
  done < <(git -C "$SCRIPT_ROOT" worktree list --porcelain | awk '/^worktree / { print substr($0, 10) }')
  [[ "$count" -eq 1 ]]
}

if [[ $# -eq 0 ]]; then
  ACTION=deploy
elif is_registered_worktree "$1" && [[ $# -ge 2 ]]; then
  WORKTREE_NAME="$1"
  ACTION="$2"
  shift 2
  CLI_ARGS=("$@")
else
  ACTION="$1"
  shift
  CLI_ARGS=("$@")
fi

if [[ "$ACTION" == "help" || "$ACTION" == "-h" || "$ACTION" == "--help" ]]; then
  cat <<'USAGE'
usage:
  ./dev.sh                         build and start the isolated dev instance
  ./dev.sh deploy                  rebuild the packaged dev instance and restart it
  ./dev.sh start|stop|restart|status
  ./dev.sh <handmux-command> ...   run the normal CLI against the dev profile
  ./dev.sh <worktree-name> <command> ...

The repository-local `hm` launcher is equivalent to `./dev.sh cli`:
  ./hm setup
  ./hm auth device status
  ./hm config

Production remains the normal global command:
  handmux setup
  handmux auth device status
USAGE
  exit 0
fi

if [[ -n "$WORKTREE_NAME" ]]; then
  if ! ROOT="$(git -C "$SCRIPT_ROOT" worktree list --porcelain | awk -v name="$WORKTREE_NAME" '
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
    rc=$?
    if [[ "$rc" -eq 2 ]]; then echo "worktree name is ambiguous: $WORKTREE_NAME" >&2
    else echo "worktree not found: $WORKTREE_NAME" >&2
    fi
    exit 1
  fi
else
  ROOT="$SCRIPT_ROOT"
fi
if [[ ! -f "$ROOT/server/package.json" || ! -f "$ROOT/web/package.json" ]]; then
  echo "invalid Handmux worktree: $ROOT" >&2
  exit 1
fi

DEV_ROOT="${HANDMUX_DEV_ROOT:-$ROOT/.handmux-dev}"
DEV_HOME="$DEV_ROOT/home"
DEV_HANDMUX_HOME="$DEV_HOME/.handmux"
DEV_TMUX_TMPDIR="$DEV_ROOT/tmux"
DEV_CONFIG="$DEV_HANDMUX_HOME/config.json"
DEV_TOKEN_FILE="$DEV_HANDMUX_HOME/token"
DEV_PORT_DEFAULT=9998
DEV_HOST_DEFAULT=0.0.0.0
CLI_ENTRY="$ROOT/server/dist/bin/handmux.js"
TEMP_DEP_LINKS=()

WORKTREE_SLOT=0
if [[ "$ROOT" != "$MAIN_WORKTREE" ]]; then
  WORKTREE_SLOT="$(git -C "$SCRIPT_ROOT" worktree list --porcelain | awk -v target="$ROOT" '
    /^worktree / { path = substr($0, 10); if (path == target) { print count; exit } count++ }
  ')"
  case "$WORKTREE_SLOT" in ''|*[!0-9]*) WORKTREE_SLOT=1 ;; esac
  DEV_PORT_DEFAULT=$((DEV_PORT_DEFAULT + WORKTREE_SLOT))
fi
DEV_PORT="${HANDMUX_DEV_PORT:-$DEV_PORT_DEFAULT}"

reject_symlink() {
  local path="$1" label="$2"
  if [[ -L "$path" ]]; then
    echo "refusing symlinked development $label: $path" >&2
    exit 2
  fi
}
reject_symlink "$DEV_ROOT" root
reject_symlink "$DEV_HOME" home
reject_symlink "$DEV_HANDMUX_HOME" profile
reject_symlink "$DEV_TMUX_TMPDIR" tmux

prepare_worktree_dependencies() {
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
      echo "run npm ci in $ROOT/$package_dir" >&2
      exit 1
    fi
    if [[ ! -f "$selected_lock" || ! -f "$source_lock" ]] || ! cmp -s "$selected_lock" "$source_lock"; then
      echo "worktree dependency lock differs: $package_dir/package-lock.json" >&2
      echo "run npm ci in $ROOT/$package_dir" >&2
      exit 1
    fi
    ln -s "$source" "$target"
    TEMP_DEP_LINKS+=("$target")
  done
}
cleanup_worktree_dependencies() {
  local link
  for link in "${TEMP_DEP_LINKS[@]-}"; do [[ -L "$link" ]] && rm -f "$link"; done
}
trap cleanup_worktree_dependencies EXIT

ensure_profile() {
  mkdir -p "$DEV_HANDMUX_HOME" "$DEV_TMUX_TMPDIR"
  chmod 700 "$DEV_ROOT" "$DEV_HOME" "$DEV_HANDMUX_HOME" "$DEV_TMUX_TMPDIR"
  if [[ ! -s "$DEV_TOKEN_FILE" ]]; then
    node --input-type=module -e "import crypto from 'node:crypto'; process.stdout.write(crypto.randomBytes(24).toString('base64url') + '\\n')" > "$DEV_TOKEN_FILE"
  fi
  chmod 600 "$DEV_TOKEN_FILE"
  DEV_TOKEN="$(cat "$DEV_TOKEN_FILE")"
  if [[ ! -s "$DEV_CONFIG" ]]; then
    cat > "$DEV_CONFIG" <<EOF
{
  "tunnel": "none",
  "port": $DEV_PORT,
  "host": "$DEV_HOST_DEFAULT",
  "name": "dev",
  "token": "$DEV_TOKEN"
}
EOF
    chmod 600 "$DEV_CONFIG"
  fi
}

run_cli() {
  ensure_profile
  if [[ ! -f "$CLI_ENTRY" ]]; then
    echo "development package is not built; run ./dev.sh deploy first" >&2
    return 1
  fi
  HOME="$DEV_HOME" \
  TMUX_TMPDIR="$DEV_TMUX_TMPDIR" \
  HANDMUX_HOST="$DEV_HOST_DEFAULT" \
  HANDMUX_PORT="$DEV_PORT" \
  HANDMUX_TOKEN="$DEV_TOKEN" \
  HANDMUX_APP_NAME=dev \
  HANDMUX_DEV_MODE=1 \
  HANDMUX_DEV_SOURCE="$ROOT" \
  HANDMUX_SERVICE_LABEL=com.handmux.dev \
  HANDMUX_SERVICE_UNIT=handmux-dev.service \
  CLAUDE_STATE_FILE="$DEV_HANDMUX_HOME/claude-state.json" \
  CODEBUDDY_STATE_FILE="$DEV_HANDMUX_HOME/codebuddy-state.json" \
  PUSH_STORE="$DEV_HANDMUX_HOME/push-subs.json" \
  PREVIEW_STORE="$DEV_HANDMUX_HOME/previews.json" \
  NOTIF_DIR="$DEV_HANDMUX_HOME/notifications" \
  CODEX_HOME="$DEV_HOME/.codex" \
  HANDMUX_EXTRA_ROOTS="$ROOT" \
  env -u TMUX -u TMUX_PANE -u HANDMUX_STATE \
  node "$CLI_ENTRY" "$@"
}

build_dev() {
  prepare_worktree_dependencies
  echo "==> building packaged development web + server from $ROOT"
  ( cd "$ROOT/server" && npm run bundle && npm run build:server )
}

deploy_dev() {
  ensure_profile
  build_dev
  run_cli stop || true
  run_cli start
  echo "==> development CLI: $ROOT/hm"
  echo "==> development URL: http://localhost:$DEV_PORT"
  echo "==> development profile: $DEV_HOME"
}

case "$ACTION" in
  deploy) deploy_dev ;;
  start|stop|restart|status) run_cli "$ACTION" ;;
  cli) run_cli "${CLI_ARGS[@]}" ;;
  *) run_cli "$ACTION" "${CLI_ARGS[@]}" ;;
esac
