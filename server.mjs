import { createServer, request as httpRequest } from 'node:http';

/**
 * Public front door for the demo container.
 *
 * Why this exists: `tcpctl serve` exposes `/health`, `/api/*` and the MCP
 * transport, but nothing at `/`. Someone who clicks Deploy and opens the URL
 * would land on a 404, which reads as "broken" rather than "here is the
 * product". This serves a real index page at `/` and reverse-proxies everything
 * else to the kernel, so the container has one public port and one coherent
 * surface.
 *
 * Keeping this in the template rather than adding a route to `tcpctl serve` means
 * the demo does not depend on a new CLI release to be useful.
 *
 * Standard library only.
 */

const PUBLIC_PORT = Number(process.env.PORT ?? 8080);
const KERNEL_PORT = Number(process.env.KERNEL_PORT ?? 8081);
const KERNEL_HOST = '127.0.0.1';
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4001);

/**
 * The index is rendered on request rather than at startup, so the capability list
 * reflects whatever the kernel actually loaded. If the kernel is not up yet the
 * page still renders and says so, instead of failing the request.
 */
async function renderIndex() {
  let capabilities = [];
  let degraded = false;
  try {
    const res = await fetch(`http://${KERNEL_HOST}:${KERNEL_PORT}/api/capabilities`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json();
    // Field names follow the kernel's own serialisation: `fullName` and
    // `riskLevel`, not `name`/`risk`. Verified against the live endpoint.
    capabilities = body.capabilities ?? [];
  } catch {
    degraded = true;
  }

  const tier = (c) => {
    if (c.agentForbidden) return { label: 'agent_forbidden', note: 'never exposed to agents' };
    if (c.approvalRequired) return { label: 'medium', note: 'a human approves the exact payload' };
    if (c.riskLevel === 'high') return { label: 'high', note: 'blocked for agents' };
    return { label: c.riskLevel ?? 'low', note: 'executes immediately' };
  };

  const rows = capabilities
    .map((c) => {
      const t = tier(c);
      const flags = [
        c.approvalRequired ? 'approval_required' : null,
        c.agentForbidden ? 'agent_forbidden' : null,
        c.contentRisk ? `content_risk:${c.contentRisk}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      return `<tr>
        <td><code>${c.fullName ?? c.name}</code></td>
        <td><span class="tier ${t.label}">${t.label}</span></td>
        <td>${t.note}</td>
        <td class="flags">${flags || '&mdash;'}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TCPcore demo &mdash; governed MCP surface</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
         max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  .sub { opacity: .7; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid rgba(128,128,128,.25); }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  .tier { font-size: .75rem; padding: .1rem .45rem; border-radius: .25rem; white-space: nowrap;
          background: rgba(128,128,128,.18); }
  .tier.low { background: rgba(40,160,80,.22); }
  .tier.medium { background: rgba(220,150,20,.25); }
  .tier.high, .tier.agent_forbidden { background: rgba(200,50,50,.22); }
  .flags { font-size: .85em; opacity: .8; }
  .note { border-left: 3px solid rgba(128,128,128,.35); padding: .6rem .9rem; margin: 1.5rem 0;
          background: rgba(128,128,128,.06); }
  ul { padding-left: 1.2rem; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>TCPcore</h1>
<p class="sub">A governed MCP surface, running with no credentials and no external services.</p>

<div class="note">
  <strong>This is a public demonstration.</strong> Identity is taken from the
  <code>x-tcpcore-actor-type</code> header rather than authenticated, which is how
  <code>tcpctl serve</code> works and why the kernel prints a development-mode
  warning at startup. Treat every tool here as world-callable. The backend is a
  mock with in-memory state, so nothing you do is persistent and nothing leaves
  the container.
</div>

${degraded ? '<div class="note">The kernel is still starting. Reload in a moment for the capability list.</div>' : ''}
${capabilities.length && !degraded
      ? `<table>
  <thead><tr><th>Capability</th><th>Risk</th><th>What happens</th><th>Declared flags</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`
      : ''}

<h2>Probe it</h2>
<ul>
  <li><a href="/api/mcp/tools"><code>/api/mcp/tools</code></a> &mdash; the tool list an agent receives</li>
  <li><a href="/api/integrations"><code>/api/integrations</code></a> &mdash; loaded adapters</li>
  <li><a href="/api/audit-log"><code>/api/audit-log</code></a> &mdash; every call, decision and denial</li>
  <li><a href="/api/approvals"><code>/api/approvals</code></a> &mdash; writes waiting for a human</li>
  <li><a href="/health"><code>/health</code></a> &mdash; liveness</li>
</ul>

<div class="note">
  <strong>Point an MCP client at this URL.</strong> Add
  <code>${'http://<this-host>'}/api/mcp</code> to Cursor or Claude Desktop.
  Only capabilities an agent is permitted to reach appear in the tool list;
  <code>agent_forbidden</code> operations are withheld entirely, and responses from
  capabilities marked <code>content_risk</code> are scanned for prompt injection
  before an agent can read them.
</div>

<h2>Try the risk tiers</h2>
<pre><code>curl -X POST ${'http://<this-host>'}/api/capabilities/demo.get_ticket/invoke \\
  -H 'Content-Type: application/json' \\
  -H 'x-tcpcore-actor-type: AGENT' \\
  -d '{"args":{"id":"T-1"}}'

curl -X POST ${'http://<this-host>'}/api/capabilities/demo.set_priority/invoke \\
  -H 'Content-Type: application/json' \\
  -H 'x-tcpcore-actor-type: AGENT' \\
  -d '{"args":{"id":"T-1","priority":"HIGH"}}'

curl -X POST ${'http://<this-host>'}/api/capabilities/demo.delete_ticket/invoke \\
  -H 'Content-Type: application/json' \\
  -H 'x-tcpcore-actor-type: AGENT' \\
  -d '{"args":{"id":"T-1"}}'</code></pre>

<p class="sub">
  The first executes. The second returns <code>pending_approval</code> and sends
  nothing upstream. The third is denied &mdash; and does not appear in the tool list
  at all. State is in memory and resets when the container restarts.
</p>
</body>
</html>`;
}

const server = createServer((req, res) => {
  // The index is the only thing this server answers itself.
  if (req.url === '/' || req.url === '/index.html') {
    renderIndex()
      .then((html) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      })
      .catch((error) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`index render failed: ${error.message}`);
      });
    return;
  }

  // Everything else goes to the kernel unchanged, including the body.
  const proxied = httpRequest(
    {
      host: KERNEL_HOST,
      port: KERNEL_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${KERNEL_HOST}:${KERNEL_PORT}` },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );

  proxied.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'kernel unavailable', kernelPort: KERNEL_PORT }));
  });

  req.pipe(proxied);
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`[server] demo listening on 0.0.0.0:${PUBLIC_PORT}`);
  console.log(`[server] proxying to the kernel on ${KERNEL_HOST}:${KERNEL_PORT}`);
  console.log(`[server] mock backend expected on ${KERNEL_HOST}:${MOCK_PORT}`);
});
