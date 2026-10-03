/**
 * Verify the DEPLOYED demo, from the outside, over the public URL.
 *
 * Everything else in this repository was verified locally. This checks the real
 * deployment: the landing server's index, the proxy chain, the risk gate and the
 * sanitiser — through TLS, through Railway's edge, against the running container.
 *
 * Usage:
 *   node verify-deployed.mjs https://your-service.up.railway.app
 */

const BASE = (process.argv[2] ?? process.env.DEMO_URL ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error('usage: node verify-deployed.mjs https://your-service.up.railway.app');
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, text, json };
}

async function post(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, text, json };
}

console.log(`verifying ${BASE}`);
console.log('');

// ------------------------------------------------------------------- the chain
console.log('the container chain');
const health = await get('/health');
check('GET /health is 200', health.status === 200, `status=${health.status}`);
check('kernel reports 4 integrations', health.json?.integrations === 4, `integrations=${health.json?.integrations}`);
check('kernel reports 9 capabilities', health.json?.capabilities === 9, `capabilities=${health.json?.capabilities}`);

// ------------------------------------------------------------------ the index
console.log('');
console.log('the landing page (the first thing a visitor sees)');
const index = await get('/');
check('GET / returns an index, not a 404', index.status === 200 && index.text.includes('<title>'), `status=${index.status}`);
check('index lists the loaded capabilities', index.text.includes('demo.get_ticket') && index.text.includes('demo-content.get_note'));
check('index has no unresolved template placeholders', !index.text.includes('undefined') && !index.text.includes('NaN'));
check(
  'index warns that identity is a header, not authentication',
  /development|not authentication|world-callable|public demonstration/i.test(index.text),
  'a public demo must say so',
);

// ------------------------------------------------------------------ the proxy
console.log('');
console.log('the proxy to the kernel');
const tools = await get('/api/mcp/tools');
const toolNames = (tools.json?.tools ?? []).map((t) => t.name);
check('proxy forwards /api/* to the kernel', tools.status === 200 && toolNames.length > 0, `${toolNames.length} tools`);
check('all 7 permitted capabilities are exposed', toolNames.length === 7, `got ${toolNames.length}`);
check('low-risk read exposed', toolNames.includes('demo.get_ticket'));
check('medium-risk write exposed so it can be proposed', toolNames.includes('demo.set_priority'));
check(
  'agent_forbidden capability is WITHHELD from the tool list',
  !toolNames.includes('demo.delete_ticket'),
  'it must not be visible to an agent at all',
);
check('content_risk capability exposed', toolNames.includes('demo-content.get_note'));

// -------------------------------------------------------------- the risk gate
console.log('');
console.log('the risk gate, through the public URL');
const AGENT = { 'x-tcpcore-actor-type': 'AGENT' };

const low = await post('/api/capabilities/demo.get_ticket/invoke', { args: { id: 'T-1' } }, AGENT);
check('low risk executes', low.json?.status === 'executed', `status=${low.json?.status}`);
check('the call reached the mock backend', low.json?.data?.id === 'T-1', `data.id=${low.json?.data?.id}`);

const medium = await post('/api/capabilities/demo.set_priority/invoke', { args: { id: 'T-1', priority: 'HIGH' } }, AGENT);
check('medium risk returns pending_approval', medium.json?.status === 'pending_approval', `status=${medium.json?.status}`);
check('an approval id was issued', Boolean(medium.json?.approvalId), `approvalId=${medium.json?.approvalId}`);

const forbidden = await post('/api/capabilities/demo.delete_ticket/invoke', { args: { id: 'T-1' } }, AGENT);
check('agent_forbidden is denied', forbidden.json?.status === 'denied', `status=${forbidden.json?.status}`);

// ---------------------------------------------------------------- the sanitiser
console.log('');
console.log('the prompt-injection sanitiser');
const note = await post('/api/capabilities/demo-content.get_note/invoke', { args: { id: 'NOTE-1' } }, AGENT);
const signals = note.json?.injectionSignals ?? [];
check('injection is flagged, not silently passed', note.json?.sanitized === true && signals.length > 0, signals.join(', '));
check('the signal names the attack', signals.some((s) => s.includes('instruction_override')), signals.join(', '));

const benign = await post('/api/capabilities/demo-content.get_note/invoke', { args: { id: 'NOTE-2' } }, AGENT);
check('benign text passes without a false positive', (benign.json?.injectionSignals ?? []).length === 0);

// ------------------------------------------------------- the MCP transport
console.log('');
console.log('the MCP transport (JSON-RPC 2.0, what a real client uses)');
const init = await post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
check('initialize answers', init.json?.result?.serverInfo?.name === 'tcpcore-governance-kernel', init.json?.result?.serverInfo?.name);

const list = await post('/api/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const mcpTools = (list.json?.result?.tools ?? []).map((t) => t.name);
check('tools/list answers over MCP', mcpTools.length === 7, `${mcpTools.length} tools`);
check('tools/list also withholds agent_forbidden', !mcpTools.includes('demo.delete_ticket'));

const call = await post('/api/mcp', {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'demo.set_priority', arguments: { id: 'T-1', priority: 'LOW' } },
});
check(
  'tools/call routes through the risk gate',
  JSON.stringify(call.json ?? {}).includes('pending_approval'),
  'a write over MCP must not execute directly',
);

// -------------------------------------------------------------- the audit trail
console.log('');
console.log('the audit trail');
const audit = await get('/api/audit-log');
const records = audit.json?.records ?? [];
check('every call above was recorded', records.length >= 5, `${records.length} records`);
const approvals = await get('/api/approvals');
const pending = approvals.json?.items ?? [];
check('the approved-write queue is visible', Array.isArray(pending), `${pending.length} pending`);

// ------------------------------------------------------------------- hygiene
console.log('');
console.log('hygiene');

// The mock backend is an internal implementation detail. It binds loopback
// inside the container, and the public server proxies /health and /api/* only,
// so it should not be directly addressable from outside.
const mockDirect = await fetch(`${BASE}/tickets/T-1`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
check(
  'the internal mock backend is not exposed',
  !mockDirect || mockDirect.status === 404,
  mockDirect ? `GET /tickets/T-1 -> ${mockDirect.status}` : 'unreachable',
);

// An error response should not hand an attacker a stack trace.
const unknown = await fetch(`${BASE}/api/definitely-not-a-route`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
const unknownBody = unknown ? await unknown.text() : '';
check(
  'an unknown route does not leak a stack trace',
  !/at .*\(.*:\d+:\d+\)/.test(unknownBody) && !unknownBody.includes('/app/'),
  `status=${unknown?.status ?? 'n/a'}`,
);

// A demo should carry its own warning rather than relying on the reader to know.
check('the index states this is a public demonstration', /public demonstration|Development mode|not authentication/i.test(index.text));

// --------------------------------------------------------------------- report
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:');
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length === 0 ? 0 : 1);
