#!/usr/bin/env bash
# dsh-telegram-channel manager (install / start / stop / status)
# curl -fsSL https://raw.githubusercontent.com/zhang0098/dsh-telegram-channel/master/scripts/install.sh | bash
set -euo pipefail

PROFILE_NAME="${DSH_PROFILE:-web}"
SOURCE="${DSH_TELEGRAM_SOURCE:-github:zhang0098/dsh-telegram-channel}"
TOKEN="${DSH_TELEGRAM_TOKEN:-}"
USER_ID="${DSH_TELEGRAM_ALLOWED_USER_IDS:-}"
PORT="${DSH_WEB_PORT:-3080}"
LOCAL=0
NO_PERSIST=0
ACTION="menu"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --user-id) USER_ID="${2:-}"; shift 2 ;;
    --profile) PROFILE_NAME="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --no-persist) NO_PERSIST=1; shift ;;
    menu|install|start|stop|status) ACTION="$1"; shift ;;
    -h|--help)
      cat <<EOF
Usage: install.sh [menu|install|start|stop|status] [--token T] [--user-id ID]
EOF
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done
need_dsh() {
  command -v dsh >/dev/null 2>&1 || { echo "dsh not found in PATH" >&2; exit 1; }
}

profile_dir() {
  local home="${DSH_HOME:-$HOME/.dsh}"
  local dir="$home/profiles/$PROFILE_NAME"
  [[ -d "$dir" ]] || { echo "Profile dir missing: $dir (run dsh web once first)" >&2; exit 1; }
  echo "$dir"
}

persist_env() {
  local name="$1" value="$2"
  local line="export ${name}=$(printf %q "$value")"
  for f in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [[ -f "$f" ]] || continue
    if grep -q "^export ${name}=" "$f" 2>/dev/null; then
      tmp="$(mktemp)"
      grep -v "^export ${name}=" "$f" >"$tmp" || true
      echo "$line" >>"$tmp"
      mv "$tmp" "$f"
    else
      echo "$line" >>"$f"
    fi
  done
}

# pnpm 10+/11: package-name alone does NOT approve git/tarball installs.
ensure_allow_builds() {
  local ws="$1/pnpm-workspace.yaml"
  if [[ ! -f "$ws" ]]; then
    cat >"$ws" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  dsh-telegram-channel: true
  'dsh-telegram-channel@git+https://github.com/zhang0098/dsh-telegram-channel.git': true
EOF
    echo "Created $ws (allowBuilds)"
    return
  fi

  # Drop pnpm auto-placeholders for this package.
  if grep -q 'dsh-telegram-channel@https://codeload.github.com' "$ws" 2>/dev/null; then
    tmp="$(mktemp)"
    grep -v 'dsh-telegram-channel@https://codeload.github.com.*set this to true or false' "$ws" >"$tmp" || true
    mv "$tmp" "$ws"
  fi

  local need_name=0 need_repo=0
  grep -qE '^[[:space:]]*dsh-telegram-channel:[[:space:]]*true[[:space:]]*$' "$ws" || need_name=1
  grep -q 'dsh-telegram-channel@git+https://github.com/zhang0098/dsh-telegram-channel.git' "$ws" || need_repo=1
  if [[ "$need_name" -eq 0 && "$need_repo" -eq 0 ]]; then
    echo "allowBuilds already present (git repo + package name), skip"
    return
  fi

  local insert=""
  [[ "$need_name" -eq 1 ]] && insert+=$'  dsh-telegram-channel: true\n'
  [[ "$need_repo" -eq 1 ]] && insert+=$'  '\''dsh-telegram-channel@git+https://github.com/zhang0098/dsh-telegram-channel.git'\'': true\n'

  if grep -q '^allowBuilds:' "$ws"; then
    tmp="$(mktemp)"
    awk -v insert="$insert" '
      BEGIN { done=0 }
      /^allowBuilds:/ {
        print
        printf "%s", insert
        done=1
        next
      }
      { print }
      END {
        if (!done) {
          print ""
          print "allowBuilds:"
          printf "%s", insert
        }
      }
    ' "$ws" >"$tmp" && mv "$tmp" "$ws"
    echo "Updated allowBuilds (git repo approval) -> $ws"
  else
    printf '\nallowBuilds:\n%s' "$insert" >>"$ws"
    echo "Appended allowBuilds -> $ws"
  fi
}

listen_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u
  fi
}

do_status() {
  echo "==> status profile=$PROFILE_NAME port=$PORT"
  if [[ -n "${DSH_TELEGRAM_TOKEN:-}" ]]; then echo "Token: set (len=${#DSH_TELEGRAM_TOKEN})"; else echo "Token: missing"; fi
  if [[ -n "${DSH_TELEGRAM_ALLOWED_USER_IDS:-}" ]]; then echo "Allow: $DSH_TELEGRAM_ALLOWED_USER_IDS"; else echo "Allow: missing"; fi
  local pids
  pids="$(listen_pids | tr '\n' ' ')"
  if [[ -n "${pids// /}" ]]; then echo "dsh web: running PIDs $pids  http://127.0.0.1:$PORT"; else echo "dsh web: not listening"; fi
}

do_install() {
  need_dsh
  [[ -n "$TOKEN" ]] || read -r -p "Bot Token: " TOKEN
  [[ -n "$USER_ID" ]] || read -r -p "Telegram numeric User ID: " USER_ID
  USER_ID="$(echo "$USER_ID" | tr -d '[:space:]')"
  [[ "$USER_ID" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "bad user id" >&2; exit 1; }
  export DSH_TELEGRAM_TOKEN="$TOKEN"
  export DSH_TELEGRAM_ALLOWED_USER_IDS="$USER_ID"
  if [[ "$NO_PERSIST" -eq 0 ]]; then
    persist_env DSH_TELEGRAM_TOKEN "$TOKEN"
    persist_env DSH_TELEGRAM_ALLOWED_USER_IDS "$USER_ID"
  fi
  local dir
  dir="$(profile_dir)"
  ensure_allow_builds "$dir"
  if [[ "$LOCAL" -eq 1 ]]; then
    SOURCE="$(cd "$(dirname "$0")/.." && pwd)"
  fi
  echo "==> dsh plugin --profile $PROFILE_NAME add $SOURCE"
  dsh plugin --profile "$PROFILE_NAME" add "$SOURCE"
  echo "Install done. Use menu option 2 / ./install.sh start"
}

do_start() {
  need_dsh
  if [[ -n "$(listen_pids)" ]]; then
    echo "Already running on :$PORT"
    return 0
  fi
  echo "==> starting dsh web in background (log: /tmp/dsh-web.log)"
  nohup dsh web >/tmp/dsh-web.log 2>&1 &
  echo $! >/tmp/dsh-web.pid
  sleep 1
  do_status
}

do_stop() {
  echo "==> stop"
  local pids
  pids="$(listen_pids)"
  if [[ -z "$pids" && -f /tmp/dsh-web.pid ]]; then
    pids="$(cat /tmp/dsh-web.pid 2>/dev/null || true)"
  fi
  if [[ -z "$pids" ]]; then
    echo "Not running"
    return 0
  fi
  echo "$pids" | xargs -r kill 2>/dev/null || echo "$pids" | xargs kill 2>/dev/null || true
  rm -f /tmp/dsh-web.pid
  echo "Stopped"
}

do_menu() {
  while true; do
    cat <<EOF

========================================
  dsh-telegram-channel manager
========================================
  1) install / reinstall
  2) start dsh web
  3) stop dsh web
  4) status
  0) quit

EOF
    read -r -p "Choice: " c
    case "$c" in
      1) do_install ;;
      2) do_start ;;
      3) do_stop ;;
      4) do_status ;;
      0) echo Bye; exit 0 ;;
      *) echo "invalid" ;;
    esac
  done
}

case "$ACTION" in
  menu) do_menu ;;
  install) do_install ;;
  start) do_start ;;
  stop) do_stop ;;
  status) do_status ;;
  *) echo "Unknown action: $ACTION" >&2; exit 1 ;;
esac
