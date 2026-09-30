# TCPcore demo template.
#
# One container, no database, no Redis, no credentials. It runs three processes:
# an in-memory mock backend, the governance kernel, and a landing server that
# serves the public index and proxies to the kernel.
#
# The CLI is installed from npm rather than built from source, so this image
# demonstrates the published artifact — the same thing a user gets from
# `npm install @tcpcore1/cli`.

FROM node:22-alpine

# Pinned to a major so the template does not silently change behaviour underneath
# a running deployment.
RUN npm install -g @tcpcore1/cli@0.1

WORKDIR /app

COPY mock-server.js /app/mock-server.js
COPY server.mjs /app/server.mjs
COPY adapters/ /app/adapters/
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

# The only publicly reachable port. The mock backend and the kernel both bind
# loopback, so neither is exposed.
EXPOSE 8080

# Probes the landing server, which proxies /health to the kernel. A pass
# therefore means the whole chain is up, not just the front door.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/health" || exit 1

CMD ["/app/entrypoint.sh"]
