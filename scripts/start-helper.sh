#!/usr/bin/env sh
set -eu

PORT="${PORT:-17888}"
HOST="${HOST:-127.0.0.1}"
NODE_BIN="${NODE:-node}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HELPER="$SCRIPT_DIR/codex-local-usage-helper.cjs"
LOG_DIR="${LOG_DIR:-$HOME/.codex}"
LOG_FILE="$LOG_DIR/codex-token-cost-helper.log"

case "$HOST" in
  127.0.0.1|::1) ;;
  *)
    echo "Helper host must be 127.0.0.1 or ::1: $HOST" >&2
    exit 1
    ;;
esac

case "$PORT" in
  ''|*[!0-9]*)
    echo "Helper port must be an integer from 1 to 65535: $PORT" >&2
    exit 1
    ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Helper port must be an integer from 1 to 65535: $PORT" >&2
  exit 1
fi

if [ ! -f "$HELPER" ]; then
  echo "Helper script not found: $HELPER" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for helper health checks" >&2
  exit 1
fi

if [ "$HOST" = "::1" ]; then
  HEALTH_HOST="[$HOST]"
else
  HEALTH_HOST="$HOST"
fi
HEALTH_URL="http://$HEALTH_HOST:$PORT/health"

is_helper_healthy() {
  HEALTH_BODY="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null || true)"
  printf '%s' "$HEALTH_BODY" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' || return 1
  printf '%s' "$HEALTH_BODY" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"codex-local-usage-helper"' || return 1
  printf '%s' "$HEALTH_BODY" | grep -Eq '"bridge"[[:space:]]*:[[:space:]]*"cc-switch"'
}

if is_helper_healthy; then
  exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already listening, but it is not the Codex Token Cost helper." >&2
  exit 1
fi

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "Node.js not found: $NODE_BIN" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
nohup "$NODE_BIN" "$HELPER" --serve --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
HELPER_PID=$!

attempt=1
while [ "$attempt" -le 20 ]; do
  sleep 0.1
  if is_helper_healthy; then
    exit 0
  fi
  if ! kill -0 "$HELPER_PID" 2>/dev/null; then
    break
  fi
  attempt=$((attempt + 1))
done

if kill -0 "$HELPER_PID" 2>/dev/null; then
  echo "Codex Token Cost helper did not become healthy at $HEALTH_URL. Log: $LOG_FILE" >&2
else
  echo "Codex Token Cost helper exited before becoming healthy. Log: $LOG_FILE" >&2
fi
exit 1
