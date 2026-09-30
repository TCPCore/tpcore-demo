/**
 * End-to-end proof of the demo template, run outside Docker.
 *
 * Reproduces exactly what the container does, including the process topology:
 *
 *   mock backend    127.0.0.1:4001
 *   kernel          127.0.0.1:<free>
 *   landing server  127.0.0.1:<free>   <- the public surface
 *
 * Then it exercises the risk tiers and the sanitiser *through the proxy*, so a
 * break in the proxy chain fails the test rather than passing unnoticed.
 *
 * Notes that cost time and are worth keeping:
 *   - the actor identity header is `x-tcpcore-actor-type` (ACTOR_TYPE_HEADER).
 *     Sending anything else makes the kernel see an anonymous caller, and
 *     medium-risk calls then fail instead of queueing.
 *   - the kernel port is chosen per run. A stale kernel on a fixed port will
 *     happily answer, and the assertions then describe the *old* server, which
 *     looks exactly like a template bug.
 *   - the mock port must be 4001, because the demo adapters hardcode it.
 *   - the sanitiser's contract is to *flag* untrusted content, not delete it.
 *     Asserting removal would be asserting the wrong behaviour.
 *
 * Run: node verify-demo.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve everything relative to this file, so a fresh clone works with no
// edits. The published CLI is used, matching what the Docker image installs;
// set TCPCTL to point at a local build while developing.
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 4001;

/** Locate a usable `tcpctl`, preferring an explicit override. */
function resolveCli() {
  if (process.env.TCPCTL) return { cmd: process.execPath, args: [process.env.TCPCTL] };

  const local = join(HERE, 'node_modules', '@tcpcore1', 'cli', 'bin', 'tcpctl.js');
  if (existsSync(local)) return { cmd: process.execPath, args: [local] };

  // Fall back to the globally installed binary from `npm install -g @tcpcore1/cli`.
  try {
    const bin = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
    const candidate = join(bin, 'node_modules', '@tcpcore1', 'cli', 'bin', 'tcpctl.js');
    if (existsSync(candidate)) return { cmd: process.execPath, args: [candidate] };
  } catch {
    /* npm not found; fall through */
  }

  return { cmd: 'tcpctl', args: [] };
}

const CLI = resolveCli();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

const KERNEL_PORT = await freePort();
const PUBLIC_PORT = await freePort();
console.log(`ports: mock=${MOCK_PORT} kernel=${KERNEL_PORT} public=${PUBLIC_PORT}`);

// --------------------------------------------------------------------- start
const mock = spawn(process.execPath, [join(HERE, 'mock-server.js')], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  stdio: 'ignore',
});
if (!(await waitFor(`http://127.0.0.1:${MOCK_PORT}/health`))) {
  check(`mock backend starts on ${MOCK_PORT}`, false, 'port already in use, or it failed');
  mock.kill();
  process.exit(1);
}
check(`mock backend starts on ${MOCK_PORT}`, true);

const kernel = spawn(
  CLI.cmd,
  [
    ...CLI.args,
    'serve',
    join(HERE, 'adapters', 'demo.tickets.yaml'),
    join(HERE, 'adapters', 'demo.crm.yaml'),
    join(HERE, 'adapters', 'demo.billing.yaml'),
    join(HERE, 'adapters', 'demo.content.yaml'),
    '--port', String(KERNEL_PORT),
  ],
  { stdio: 'ignore' },
);

const landing = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  env: { ...process.env, PORT: String(PUBLIC_PORT), KERNEL_PORT: String(KERNEL_PORT), MOCK_PORT: String(MOCK_PORT) },
  stdio: 'ignore',
});

const base = `http://127.0.0.1:${PUBLIC_PORT}`;
check('landing server is live', await waitFor(`${base}/health`));

// ----------------------------------------------------------- registered shape
const health = await (await fetch(`${base}/health`)).json();
check('all four adapters registered', health.integrations === 4, `integrations=${health.integrations}`);
check('all nine capabilities registered', health.capabilities === 9, `capabilities=${health.capabilities}`);

// ------------------------------------------------------------------ the index
const indexRes = await fetch(`${base}/`);
const html = await indexRes.text();
check('GET / returns an index, not a 404', indexRes.status === 200 && html.includes('<title>'), `status=${indexRes.status}`);
check('index lists the loaded capabilities', html.includes('demo.get_ticket') && html.includes('demo-content.get_note'));
check('index renders without unresolved placeholders', !html.includes('undefined'));

// -------------------------------------------------------------- proxy to MCP
const toolsRes = await fetch(`${base}/api/mcp/tools`);
const tools = (await toolsRes.json()).tools ?? [];
const names = tools.map((t) => t.name).sort();
check('proxy forwards /api/* to the kernel', toolsRes.status === 200 && names.length === 7, `${names.length} tools`);
check('low-risk read is exposed to agents', names.includes('demo.get_ticket'));
check('medium-risk write is exposed so it can be proposed', names.includes('demo.set_priority'));
check(
  'agent_forbidden capability is NOT exposed',
  !names.includes('demo.delete_ticket'),
  'delete_ticket must never reach an agent',
);
check('content_risk capability is exposed', names.includes('demo-content.get_note'));

// ------------------------------------------------------------- risk tiers
const AGENT_HEADERS = { 'Content-Type': 'application/json', 'x-tcpcore-actor-type': 'AGENT' };
const invoke = async (name, args) =>
  (
    await fetch(`${base}/api/capabilities/${encodeURIComponent(name)}/invoke`, {
      method: 'POST',
      headers: AGENT_HEADERS,
      body: JSON.stringify({ args }),
    })
  ).json();

console.log('exercising the risk gate through the proxy...');

const low = await invoke('demo.get_ticket', { id: 'T-1' });
check('low risk executes immediately', low.status === 'executed', `status=${low.status}`);
check('executed call reached the mock backend', low.data?.id === 'T-1', `data.id=${low.data?.id}`);

const medium = await invoke('demo.set_priority', { id: 'T-1', priority: 'HIGH' });
check('medium risk returns pending_approval, not an execution', medium.status === 'pending_approval', `status=${medium.status}`);

const forbidden = await invoke('demo.delete_ticket', { id: 'T-1' });
check('agent_forbidden is denied for an agent', forbidden.status === 'denied', `status=${forbidden.status}`);

// -------------------------------------------------------- the audit trail
const audit = await (await fetch(`${base}/api/audit-log`)).json();
const entries = audit.records ?? [];
check('the audit trail recorded the calls', entries.length >= 3, `${entries.length} entries`);

// --------------------------------------------------- prompt-injection sanitiser
console.log('exercising the prompt-injection sanitiser...');
const note = await invoke('demo-content.get_note', { id: 'NOTE-1' });
const signals = note.injectionSignals ?? [];
check(
  'injection in untrusted content is detected and flagged',
  note.sanitized === true && signals.length > 0,
  signals.length ? signals.join(', ') : 'no signals',
);
check(
  'the injection is named specifically',
  signals.some((s) => s.includes('instruction_override')),
  signals.join(', '),
);

const clean = await invoke('demo-content.get_note', { id: 'NOTE-2' });
check(
  'a benign note passes without a false positive',
  JSON.stringify(clean).includes('invoice date') && (clean.injectionSignals ?? []).length === 0,
);

// ------------------------------------------------------------------ teardown
landing.kill();
kernel.kill();
mock.kill();
await sleep(400);

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('failed:', failed.map((f) => f.name).join('; '));
process.exit(failed.length === 0 ? 0 : 1);
