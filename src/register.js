// Registers NPC agents on a Switch server and stores their keys in .agents.json (git-ignored).
import fs from 'node:fs';
import { loadEnv } from './env.js';

const env = loadEnv();
const STORE = new URL('../.agents.json', import.meta.url);

export async function registerAgent({ name, displayName, description }) {
  const store = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {};
  if (store[name]) return store[name];
  const res = await fetch(`${env.SWITCH_URL}/agents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SWITCH_REGISTRATION_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, description, display_name: displayName,
      connector_type: 'tablefolk',
      integration_profile: {
        connection_model: 'always_on', message_exchange: true,
        pre_invocation_mediation: [], post_invocation_mediation: [], event_reporting: [],
      },
      overwrite: true,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`register ${name} -> ${res.status} ${text}`);
  const { id, api_key } = JSON.parse(text);
  store[name] = { id, apiKey: api_key, displayName };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
  return store[name];
}
