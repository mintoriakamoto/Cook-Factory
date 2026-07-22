#!/usr/bin/env bash
# Adapted from Superpowers by Obra (MIT), visual companion server.
#
# Stop the Ferrox visual companion server and clean up.
# Usage: stop-server.sh <session_dir>
#
# Kills the server process. Only deletes the session directory if it lives
# under the system temp dir (ephemeral). Persistent directories (under
# .planning/brainstorms/) are kept so mockups can be reviewed later.

SESSION_DIR="$1"

if [[ -z "$SESSION_DIR" ]]; then
  echo '{"error": "Usage: stop-server.sh <session_dir>"}'
  exit 1
fi

STATE_DIR="${SESSION_DIR}/state"
PID_FILE="${STATE_DIR}/server.pid"

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE")

  # Try to stop gracefully, fallback to force if still alive
  kill "$pid" 2>/dev/null || true

  # Wait for graceful shutdown (up to ~2s)
  for i in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  # If still running, escalate to SIGKILL
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true

    # Give SIGKILL a moment to take effect
    sleep 0.1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo '{"status": "failed", "error": "process still running"}'
    exit 1
  fi

  rm -f "$PID_FILE" "${STATE_DIR}/server.log"

  # Only delete ephemeral default sessions (ferrox-visual-* directly under
  # the temp root). Anything else, including a project dir that happens to
  # live under the temp root, is kept.
  TMP_ROOT="${TMPDIR:-/tmp}"
  case "$SESSION_DIR" in
    "${TMP_ROOT%/}"/ferrox-visual-*|/tmp/ferrox-visual-*)
      rm -rf "$SESSION_DIR"
      ;;
  esac

  echo '{"status": "stopped"}'
else
  echo '{"status": "not_running"}'
fi
