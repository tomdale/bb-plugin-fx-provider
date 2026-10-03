#!/usr/bin/env bash
# Runs a private bb server for manual QA of this plugin. It uses an installed
# bb desktop app's Electron executable in Node mode (ELECTRON_RUN_AS_NODE=1),
# which is how the desktop app runs its server, daemon, and provider bridges,
# with its own data directory and ports. The bb you use day to day is not
# touched as long as `bb` commands run with the env this script writes.
#
# Usage: scripts/qa/isolated-bb.sh start|stop|status|env
#
#   start   start the server and write $QA_DIR/env.sh
#   stop    stop it and every process that references its data directory
#   status  report whether it is running
#   env     print the exports; use as: eval "$(scripts/qa/isolated-bb.sh env)"
#
# Environment:
#   BB_APP       bb app bundle (default /Applications/bb.app). The app must host
#                the plugin SDK version package.json requires; `start` prints it.
#   BB_BIN       its executable (default: the bundle's CFBundleExecutable)
#   QA_DIR       state directory (default ${TMPDIR:-/tmp}/bb-plugin-fx-qa)
#   SERVER_PORT  server port (default 41886); the host daemon uses SERVER_PORT+1
#                unless DAEMON_PORT is set
#
# Never run the bb executable without ELECTRON_RUN_AS_NODE=1: it then starts
# (or signals) the desktop app instead of Node.
set -euo pipefail

APP=${BB_APP:-/Applications/bb.app}
QA_DIR=${QA_DIR:-${TMPDIR:-/tmp}/bb-plugin-fx-qa}
QA_DIR=${QA_DIR%/}
DATA_DIR=$QA_DIR/data
SERVER_PORT=${SERVER_PORT:-41886}
DAEMON_PORT=${DAEMON_PORT:-$((SERVER_PORT + 1))}
PID_FILE=$QA_DIR/launcher.pid
LOG_FILE=$QA_DIR/launcher.log
ENV_FILE=$QA_DIR/env.sh
BB_APP_DIR=$APP/Contents/Resources/app.asar.unpacked/node_modules/bb-app

# Variables that would point bb commands, or the server's children, at another
# bb (for example when this runs inside a bb thread).
BB_SCOPE_VARS=(BB_THREAD_ID BB_PROJECT_ID BB_ENVIRONMENT_ID BB_THREAD_STORAGE
  BB_CLI BB_SERVER_URL BB_SERVER_PORT BB_HOST_DAEMON_PORT BB_DATA_DIR)

executable() {
  if [[ -n ${BB_BIN:-} ]]; then
    printf '%s\n' "$BB_BIN"
    return
  fi
  local name
  name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \
    "$APP/Contents/Info.plist" 2>/dev/null) || {
    echo "isolated-bb: cannot read $APP/Contents/Info.plist; set BB_APP or BB_BIN" >&2
    exit 1
  }
  printf '%s\n' "$APP/Contents/MacOS/$name"
}

running_pid() {
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid"
  fi
}

env_lines() {
  printf 'unset %s\n' "${BB_SCOPE_VARS[*]}"
  printf 'export BB_DATA_DIR=%q BB_SERVER_URL=%q BB_SERVER_PORT=%q BB_HOST_DAEMON_PORT=%q\n' \
    "$DATA_DIR" "http://127.0.0.1:$SERVER_PORT" "$SERVER_PORT" "$DAEMON_PORT"
}

start() {
  if [[ -n $(running_pid) ]]; then
    echo "isolated-bb: already running (pid $(running_pid)); source $ENV_FILE" >&2
    exit 1
  fi
  local bin sdk
  bin=$(executable)
  [[ -x $bin ]] || { echo "isolated-bb: no executable at $bin" >&2; exit 1; }
  [[ -d $BB_APP_DIR ]] || { echo "isolated-bb: no bb-app in $APP" >&2; exit 1; }
  sdk=$(grep -rhoE 'PLUGIN_SDK_VERSION = "[^"]+"' "$BB_APP_DIR/server/dist" 2>/dev/null |
    head -1 | cut -d'"' -f2 || true)
  mkdir -p "$DATA_DIR"
  local unset_args=()
  for name in "${BB_SCOPE_VARS[@]}"; do unset_args+=(-u "$name"); done
  (
    cd "$BB_APP_DIR"
    env "${unset_args[@]}" ELECTRON_RUN_AS_NODE=1 nohup "$bin" dist/bb-app.js \
      --data-dir "$DATA_DIR" --server-port "$SERVER_PORT" \
      --host-daemon-port "$DAEMON_PORT" --bundled >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )
  env_lines >"$ENV_FILE"
  for _ in $(seq 1 120); do
    if grep -q "bb is ready" "$LOG_FILE" 2>/dev/null; then
      echo "isolated bb ready: $APP (plugin SDK ${sdk:-unknown}), data $DATA_DIR,"
      echo "server $SERVER_PORT, daemon $DAEMON_PORT. Run: source $ENV_FILE"
      return
    fi
    if [[ -z $(running_pid) ]]; then break; fi
    sleep 0.5
  done
  echo "isolated-bb: bb did not become ready; log: $LOG_FILE" >&2
  tail -20 "$LOG_FILE" >&2 || true
  stop >&2
  exit 1
}

stop() {
  local pid
  pid=$(running_pid)
  if [[ -n $pid ]]; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  # The server, daemon, bridges, and agents all carry the data directory in
  # their arguments or inherit it; sweep any that outlived the launcher.
  pkill -f -- "$DATA_DIR" 2>/dev/null || true
  sleep 1
  if pgrep -f -- "$DATA_DIR" >/dev/null; then
    echo "isolated-bb: processes still reference $DATA_DIR:" >&2
    pgrep -fl -- "$DATA_DIR" >&2
    exit 1
  fi
  echo "isolated bb stopped ($DATA_DIR)"
}

case ${1:-} in
start) start ;;
stop) stop ;;
status)
  if [[ -n $(running_pid) ]]; then
    echo "running (pid $(running_pid)), server $SERVER_PORT, data $DATA_DIR"
  else
    echo "not running ($DATA_DIR)"
    exit 1
  fi
  ;;
env) env_lines ;;
*)
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac
