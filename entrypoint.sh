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
# server answers `/` with a real index and proxies everything else through to the
# kernel, which keeps the public surface honest without requiring a new CLI
# release.
set -e

MOCK_PORT="${MOCK_PORT:-4001}"
KERNEL_PORT="${KERNEL_PORT:-8081}"
PUBLIC_PORT="${PORT:-8080}"

echo "[entrypoint] mock backend      -> 127.0.0.1:${MOCK_PORT}"
MOCK_PORT="$MOCK_PORT" node /app/mock-server.js &
MOCK_PID=$!

# Bounded wait, with an early exit if the mock died — otherwise a broken mock
# hangs the container until the platform's own timeout.
ready=0
i=0
while [ "$i" -lt 40 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${MOCK_PORT}/health" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "[entrypoint] mock backend exited during startup" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "[entrypoint] mock backend not ready after 20s" >&2
  exit 1
fi
echo "[entrypoint] mock backend ready"

echo "[entrypoint] kernel            -> 127.0.0.1:${KERNEL_PORT}"
tcpctl serve /app/adapters/demo.tickets.yaml \
             /app/adapters/demo.crm.yaml \
             /app/adapters/demo.billing.yaml \
             /app/adapters/demo.content.yaml \
             --port "$KERNEL_PORT" &
KERNEL_PID=$!

# Wait for the kernel before exposing the landing server, so the first visitor
# does not get a half-rendered index.
kready=0
i=0
while [ "$i" -lt 60 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${KERNEL_PORT}/health" 2>/dev/null; then
    kready=1
    break
  fi
  if ! kill -0 "$KERNEL_PID" 2>/dev/null; then
    echo "[entrypoint] kernel exited during startup" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done

if [ "$kready" -ne 1 ]; then
  echo "[entrypoint] kernel not ready after 30s" >&2
  exit 1
fi
echo "[entrypoint] kernel ready"

echo "[entrypoint] landing server    -> 0.0.0.0:${PUBLIC_PORT} (public)"
# Exported rather than passed as an assignment prefix: `VAR=x exec cmd` is not a
# valid POSIX prefix for `exec`, and the variables would not reach the process.
export PUBLIC_PORT KERNEL_PORT MOCK_PORT
# exec so this is PID 1 and receives SIGTERM directly.
exec node /app/server.mjs
