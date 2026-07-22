#!/usr/bin/env bash
# Adapted from Superpowers by Obra (MIT), visual companion server.
#
# Start the Ferrox visual companion server and output connection info.
# Usage: start-server.sh [--project-dir <path>] [--session <name>] [--port <n>]
#                        [--host <bind-host>] [--url-host <display-host>]
#                        [--foreground] [--background]
#
# Starts the server (random high port unless --port given), outputs the
# server-started JSON handshake. Each session gets its own directory.
#
# Options:
#   --project-dir <path>  Store session files under
#                         <path>/.planning/brainstorms/<session>/ instead of
#                         the system temp dir. Files persist after stop.
#   --session <name>      Session directory name (default: visual-<pid>-<epoch>).
#   --port <n>            Bind a specific port (0 = OS-assigned ephemeral).
#   --host <bind-host>    Host/interface to bind (default: 127.0.0.1).
#                         Use 0.0.0.0 in remote/containerized environments.
#   --url-host <host>     Hostname shown in returned URL JSON.
#   --foreground          Run server in the current terminal (no backgrounding).
#   --background          Force background mode (overrides Codex auto-foreground).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse arguments
PROJECT_DIR=""
SESSION_NAME=""
PORT=""
FOREGROUND="false"
FORCE_BACKGROUND="false"
BIND_HOST="127.0.0.1"
URL_HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --session)
      SESSION_NAME="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --host)
      BIND_HOST="$2"
      shift 2
      ;;
    --url-host)
      URL_HOST="$2"
      shift 2
      ;;
    --foreground|--no-daemon)
      FOREGROUND="true"
      shift
      ;;
    --background|--daemon)
      FORCE_BACKGROUND="true"
      shift
      ;;
    *)
      echo "{\"error\": \"Unknown argument: $1\"}"
      exit 1
      ;;
  esac
done

if [[ -z "$URL_HOST" ]]; then
  if [[ "$BIND_HOST" == "127.0.0.1" || "$BIND_HOST" == "localhost" ]]; then
    URL_HOST="localhost"
  else
    URL_HOST="$BIND_HOST"
  fi
fi

# Some environments reap detached/background processes. Auto-foreground when detected.
if [[ -n "${CODEX_CI:-}" && "$FOREGROUND" != "true" && "$FORCE_BACKGROUND" != "true" ]]; then
  FOREGROUND="true"
fi

# Windows/Git Bash reaps nohup background processes. Auto-foreground when detected.
if [[ "$FOREGROUND" != "true" && "$FORCE_BACKGROUND" != "true" ]]; then
  case "${OSTYPE:-}" in
    msys*|cygwin*|mingw*) FOREGROUND="true" ;;
  esac
  if [[ -n "${MSYSTEM:-}" ]]; then
    FOREGROUND="true"
  fi
fi

# Generate unique session directory
if [[ -z "$SESSION_NAME" ]]; then
  SESSION_NAME="visual-$$-$(date +%s)"
fi

if [[ -n "$PROJECT_DIR" ]]; then
  SESSION_DIR="${PROJECT_DIR}/.planning/brainstorms/${SESSION_NAME}"
else
  SESSION_DIR="${TMPDIR:-/tmp}/ferrox-visual-${SESSION_NAME}"
fi

STATE_DIR="${SESSION_DIR}/state"
PID_FILE="${STATE_DIR}/server.pid"
LOG_FILE="${STATE_DIR}/server.log"

# Create fresh session directory with screens and state peers
mkdir -p "${SESSION_DIR}/screens" "$STATE_DIR"

# Kill any existing server for this session (stale-session cleanup)
if [[ -f "$PID_FILE" ]]; then
  old_pid=$(cat "$PID_FILE")
  kill "$old_pid" 2>/dev/null
  rm -f "$PID_FILE"
fi
rm -f "${STATE_DIR}/server-stopped"

cd "$SCRIPT_DIR"

# Resolve the harness PID (grandparent of this script).
# $PPID is the ephemeral shell the harness spawned to run us. It dies
# when this script exits. The harness itself is $PPID's parent.
OWNER_PID="$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')"
if [[ -z "$OWNER_PID" || "$OWNER_PID" == "1" ]]; then
  OWNER_PID="$PPID"
fi

# Foreground mode for environments that reap detached/background processes.
if [[ "$FOREGROUND" == "true" ]]; then
  echo "$$" > "$PID_FILE"
  env FERROX_VISUAL_DIR="$SESSION_DIR" FERROX_VISUAL_HOST="$BIND_HOST" FERROX_VISUAL_URL_HOST="$URL_HOST" FERROX_VISUAL_OWNER_PID="$OWNER_PID" ${PORT:+FERROX_VISUAL_PORT="$PORT"} node server.cjs
  exit $?
fi

# Start server, capturing output to log file
# Use nohup to survive shell exit; disown to remove from job table
nohup env FERROX_VISUAL_DIR="$SESSION_DIR" FERROX_VISUAL_HOST="$BIND_HOST" FERROX_VISUAL_URL_HOST="$URL_HOST" FERROX_VISUAL_OWNER_PID="$OWNER_PID" ${PORT:+FERROX_VISUAL_PORT="$PORT"} node server.cjs > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server-started message (check log file)
for i in {1..50}; do
  if grep -q "server-started" "$LOG_FILE" 2>/dev/null; then
    # Verify server is still alive after a short window (catches process reapers)
    alive="true"
    for _ in {1..20}; do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        alive="false"
        break
      fi
      sleep 0.1
    done
    if [[ "$alive" != "true" ]]; then
      echo "{\"error\": \"Server started but was killed. Retry in a persistent terminal with: $SCRIPT_DIR/start-server.sh${PROJECT_DIR:+ --project-dir $PROJECT_DIR} --host $BIND_HOST --url-host $URL_HOST --foreground\"}"
      exit 1
    fi
    grep "server-started" "$LOG_FILE" | head -1
    exit 0
  fi
  # Fast fail: the server process died before it could start (for example a
  # port collision, which the server reports as a server-error JSON line).
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    err_line=$(grep "server-error" "$LOG_FILE" 2>/dev/null | head -1)
    if [[ -n "$err_line" ]]; then
      echo "$err_line"
    else
      echo '{"error": "Server process exited before startup completed"}'
    fi
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.1
done

# Timeout: server did not start
echo '{"error": "Server failed to start within 5 seconds"}'
exit 1
