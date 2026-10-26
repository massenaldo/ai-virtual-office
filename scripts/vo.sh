#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="http://localhost:5173"
# Optional first argument (or CLAUDE_SESSION_ID): the Claude Code session ID, added to the link as localhost:5173/sessionID=<ID>.
SESSION_ID="${1:-${CLAUDE_SESSION_ID:-}}"
OPEN_URL="$URL"
if [ -n "$SESSION_ID" ]; then
  OPEN_URL="$URL/sessionID=$SESSION_ID"
fi
LOG_FILE="$ROOT_DIR/.vo-server.log"
PID_FILE="$ROOT_DIR/.vo-server.pid"

is_healthy() {
  curl --silent --fail --max-time 1 "$URL" >/dev/null 2>&1
}
open_browser() {
  echo "Virtual office link: $OPEN_URL"
  case "$(uname -s)" in
    Darwin) open "$OPEN_URL" ;;
    Linux) if command -v xdg-open >/dev/null 2>&1; then xdg-open "$OPEN_URL" >/dev/null 2>&1 || true; else echo "Open $OPEN_URL in your browser."; fi ;;
    MINGW*|MSYS*|CYGWIN*) cmd.exe /c start "" "$OPEN_URL" >/dev/null 2>&1 || echo "Open $OPEN_URL in your browser." ;;
    *) echo "Open $OPEN_URL in your browser." ;;
  esac
}

if is_healthy; then
  echo "AI Virtual Office is already running at $URL"
  open_browser
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js LTS from https://nodejs.org/ and retry." >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "Installing project dependencies..."
  (cd "$ROOT_DIR" && npm install)
fi

echo "Starting AI Virtual Office..."
# VO_AUTO_EXIT=1 makes the server stop as soon as the last browser page closes (see scripts/voAutoExit.ts).
(cd "$ROOT_DIR" && VO_AUTO_EXIT=1 nohup npm run dev > "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE")

for _ in $(seq 1 40); do
  if is_healthy; then
    echo "AI Virtual Office is ready at $URL"
    open_browser
    exit 0
  fi
  sleep 0.5
done

echo "The office server did not become ready. Recent log output:" >&2
tail -n 50 "$LOG_FILE" 2>/dev/null || true
exit 1
