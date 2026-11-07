// npm run doctor: checks everything a table needs, and says how to fix what's missing.
import fs from 'node:fs';
import { loadEnv } from './env.js';
import { provider } from './llm.js';

const env = loadEnv();
let failed = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg, fix) => { failed++; console.log(`  FAIL  ${msg}\n        fix: ${fix}`); };
const warn = (msg, fix) => console.log(`  warn  ${msg}\n        ${fix}`);
const get = async (url, init = {}) => { try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: e.message }; } };

console.log('Tablefolk doctor\n');

// 1. Settings
if (env.SWITCH_URL) ok(`SWITCH_URL is ${env.SWITCH_URL}`);
else bad('SWITCH_URL is not set', 'add SWITCH_URL=http://127.0.0.1:<bridge port> to .env (Switch Console > Admin > Status shows the server; the port is in ~/Library/Application Support/switchdash/local-switch-server/ports.json as "api")');
if (env.SWITCH_REGISTRATION_TOKEN) ok('SWITCH_REGISTRATION_TOKEN is set');
else bad('SWITCH_REGISTRATION_TOKEN is not set', 'add a registration key for this Switch server to .env');

// 2. Switch itself
if (env.SWITCH_URL) {
  const h = await get(`${env.SWITCH_URL}/health`);
  if (h.status === 200) ok('Switch answers /health');
  else bad(`Switch did not answer /health (${h.status || h.text})`, 'start the server in Switch Console (Admin > Status > Start), or fix SWITCH_URL');

  // A harmless authenticated call: an unknown agent type is refused with 400 only after the token is accepted.
  if (h.status === 200 && env.SWITCH_REGISTRATION_TOKEN) {
    const r = await get(`${env.SWITCH_URL}/agents/register-known`, { method: 'POST', headers: { Authorization: `Bearer ${env.SWITCH_REGISTRATION_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'tablefolk-doctor-probe', name: 'doctor-probe', description: 'probe' }) });
    if (r.status === 400) ok('the registration token is accepted');
    else if (r.status === 401) bad('the registration token was refused (401)', 'mint a new registration key for this server and put it in .env');
    else warn(`unexpected answer to the token check (${r.status})`, r.text.slice(0, 160));
  }
}

// 3. Agents registered by this checkout
const store = new URL('../.agents.json', import.meta.url);
const agents = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
const needed = ['table-keeper', 'duke-aldric', 'captain-voss', 'fen-the-fence'];
const missing = needed.filter((n) => !agents[n]);
if (!missing.length) ok(`agents registered: ${needed.join(', ')}`);
else warn(`not registered yet: ${missing.join(', ')}`, 'npm run table registers them on first run');

// 4. The chat bridge, asked as the Keeper
if (agents['table-keeper'] && env.SWITCH_URL) {
  const { id, apiKey } = agents['table-keeper'];
  const r = await get(`${env.SWITCH_URL}/agents/${id}/ops/list_bridges`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: '{}' });
  if (r.status === 401 || r.status === 404) bad(`the Keeper's key was refused (${r.status})`, 'delete .agents.json and run npm run table to register the agents again');
  else if (r.status === 200) {
    const bridges = JSON.parse(r.text).result ?? [];
    const def = bridges.find((b) => b.is_default);
    if (def?.status === 'active') ok(`default chat bridge: ${def.display_name} (${def.status})`);
    else if (def) warn(`default chat bridge ${def.display_name} is ${def.status}`, 'start it from Switch Console (Admin > Status); if it stays down after Docker restarts, restart the server there');
    else warn('no default chat bridge', 'turn on Mattermost in Switch Console (Admin > Status). Without one, only agent-only rooms work (npm run demo, npm run test:e2e)');
  } else warn(`could not list bridges (${r.status})`, r.text.slice(0, 160));
}

// 5. Mattermost, if it is the bundled one
const ports = `${process.env.HOME}/Library/Application Support/switchdash/local-switch-server/ports.json`;
const mmPort = fs.existsSync(ports) ? JSON.parse(fs.readFileSync(ports, 'utf8')).mattermost : null;
if (mmPort) {
  const m = await get(`http://127.0.0.1:${mmPort}/api/v4/system/ping`);
  if (m.status === 200) ok(`Mattermost answers on port ${mmPort}`);
  else warn(`Mattermost is not answering on port ${mmPort}`, 'start Docker (OrbStack or Docker Desktop); Switch Console runs Mattermost in it');
}

// 6. The model that voices the NPCs
if (provider === 'anthropic') ok('NPC voices: Anthropic API (ANTHROPIC_API_KEY is set)');
else if (provider === 'ollama') {
  const t = await get(`${env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/tags`);
  const model = env.NPC_MODEL || 'gemma4:e2b-it-qat';
  if (t.status !== 200) bad('Ollama is not running', 'start Ollama, or put ANTHROPIC_API_KEY in .env');
  else if (!JSON.parse(t.text).models?.some((m) => m.name === model)) bad(`Ollama has no ${model}`, `ollama pull ${model}, or set NPC_MODEL in .env`);
  else ok(`NPC voices: ${model} via Ollama`);
} else ok(`NPC voices: ${provider}`);

console.log(failed ? `\n${failed} problem${failed === 1 ? '' : 's'} to fix.` : '\nAll set. Run npm run table.');
process.exit(failed ? 1 : 0);
