#!/bin/sh
# Entrypoint for the TCPcore demo container.
#
# Three processes, one container, no external services:
#
#   mock backend    127.0.0.1:4001   in-memory SaaS stand-in
#   kernel          127.0.0.1:8081   tcpctl serve, the governed MCP surface
#   landing server  0.0.0.0:$PORT    the only publicly reachable port
#
# The kernel is deliberately NOT the public listener: `tcpctl serve` has no route
# at `/`, so a visitor opening the deployed URL would see a 404. The landing
# server answers `/` with a real index and proxies everything else through.
#
# WHY THIS SCRIPT LOGS SO MUCH
#
# The first version backgrounded both children with their output discarded, so a
# failed start printed only "kernel exited during startup" and nothing else. That
# is the worst possible failure mode in a container you cannot shell into: the
# one message you need is the one that was thrown away. Every child now writes to
# a log that is dumped on failure, and every step is announced.
#
# `set -e` is deliberately NOT used. With background jobs and `wait`, it makes
# exit-status handling surprising precisely where the diagnostics matter.

MOCK_PORT="${MOCK_PORT:-4001}"
KERNEL_PORT="${KERNEL_PORT:-8081}"
PUBLIC_PORT="${PORT:-8080}"
MOCK_LOG=/tmp/mock.log
KERNEL_LOG=/tmp/kernel.log

log() { echo "[entrypoint] $*"; }

# Report a child's failure with its output. Takes the log path and a label.
fail_with_log() {
  _label=$1
  _log=$2
  echo "[entrypoint] ${_label} failed" >&2
  echo "[entrypoint] --- ${_label} output ---" >&2
  if [ -f "$_log" ]; then
    cat "$_log" >&2
  else
    echo "(no log file at ${_log})" >&2
  fi
  echo "[entrypoint] --- end ${_label} output ---" >&2
}

# ------------------------------------------------------------------ environment
log "node $(node --version), cwd $(pwd)"
log "PATH=${PATH}"

# ------------------------------------------------------------------ locate the CLI
#
# Resolve the CLI to an absolute path rather than relying on `tcpctl` being on
# PATH. Two reasons: a PATH problem then reports itself as "not found" instead of
# a startup timeout, and `node <abs path>` makes the process we track unambiguous.
CLI_JS=""
for candidate in \
  "${TCPCTL_JS:-}" \
  "$(npm prefix -g 2>/dev/null)/lib/node_modules/@tcpcore1/cli/bin/tcpctl.js" \
  "$(npm root -g 2>/dev/null)/@tcpcore1/cli/bin/tcpctl.js" \
  "/usr/local/lib/node_modules/@tcpcore1/cli/bin/tcpctl.js" \
  "/usr/lib/node_modules/@tcpcore1/cli/bin/tcpctl.js" \
  "/app/node_modules/@tcpcore1/cli/bin/tcpctl.js"
do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    CLI_JS="$candidate"
    break
  fi
done

if [ -z "$CLI_JS" ]; then
  echo "[entrypoint] could not locate @tcpcore1/cli" >&2
  echo "[entrypoint] a bare 'tcpctl' would at least report its own error:" >&2
  command -v tcpctl >&2 || echo "  tcpctl is not on PATH" >&2
  tcpctl --version >&2 2>&1 || true
  exit 1
fi
log "cli            -> ${CLI_JS}"

# ------------------------------------------------------------------ mock backend
log "mock backend      -> 127.0.0.1:${MOCK_PORT}"
MOCK_PORT="$MOCK_PORT" node /app/mock-server.js >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!

ready=0
i=0
while [ "$i" -lt 40 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${MOCK_PORT}/health" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    fail_with_log "mock backend" "$MOCK_LOG"
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "[entrypoint] mock backend not ready after 20s" >&2
  fail_with_log "mock backend" "$MOCK_LOG"
  exit 1
fi
log "mock backend ready"

# ----------------------------------------------------------------------- kernel
log "kernel            -> 127.0.0.1:${KERNEL_PORT}"
node "$CLI_JS" serve /app/adapters/demo.tickets.yaml \
                     /app/adapters/demo.crm.yaml \
                     /app/adapters/demo.billing.yaml \
                     /app/adapters/demo.content.yaml \
                     --port "$KERNEL_PORT" >"$KERNEL_LOG" 2>&1 &
KERNEL_PID=$!

kready=0
i=0
while [ "$i" -lt 60 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${KERNEL_PORT}/health" 2>/dev/null; then
    kready=1
    break
  fi
  if ! kill -0 "$KERNEL_PID" 2>/dev/null; then
    wait "$KERNEL_PID"
    status=$?
    echo "[entrypoint] kernel exited during startup (exit ${status})" >&2
    fail_with_log "kernel" "$KERNEL_LOG"
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done

if [ "$kready" -ne 1 ]; then
  echo "[entrypoint] kernel not ready after 30s" >&2
  fail_with_log "kernel" "$KERNEL_LOG"
  exit 1
fi
log "kernel ready"
# Surface the kernel's own banner (adapter list, tool count) in the deploy log.
cat "$KERNEL_LOG"

# --------------------------------------------------------------- landing server
log "landing server    -> 0.0.0.0:${PUBLIC_PORT} (public)"
export PUBLIC_PORT KERNEL_PORT MOCK_PORT
exec node /app/server.mjs
