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

// Lets anyone address these agents (players @mentioning an NPC), not just their owner,
// and gives each its portrait as its avatar in the chat app. An agent can't change its
// own settings, so the first agent updates the others and the second updates the first.
// They must share an owner, which agents made with one registration token do.
export async function openAddressing(first, others, icons = {}) {
  const { SwitchAgent } = await import('./switch-client.js');
  const updateAs = async (by, targets) => {
    const conn = new SwitchAgent({ baseUrl: env.SWITCH_URL, agentId: by.id, apiKey: by.apiKey, name: 'addressing', rooms: [] });
    await conn.start();
    for (const t of targets) {
      const icon = icons[t.id] ? { icon_url: icons[t.id] } : {};
      await conn.op('update_agent_detail', { agent_id: t.id, addressing: 'anyone', ...icon })
        .catch((e) => console.error(`could not update agent settings: ${e.message}`));
    }
    conn.stop();
  };
  if (!others.length) return;
  await updateAs(first, others);
  await updateAs(others[0], [first]);
}
