// @ts-check
// One short in-character line per call. Provider picked from env:
//   ANTHROPIC_API_KEY -> Anthropic Messages API (fast, default)
//   otherwise -> local Ollama model (free, offline)
//   NPC_PROVIDER=cli -> the `claude` CLI if it is installed and logged in (slow)
import { spawn } from 'node:child_process';
import { loadEnv } from './env.js';

const env = loadEnv();
export const provider = env.NPC_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama');

/** @param {string} system @param {string} prompt @returns {Promise<string>} */
export async function speak(system, prompt) {
  if (provider === 'anthropic') return viaApi(system, prompt);
  if (provider === 'ollama') return viaOllama(system, prompt);
  return viaCli(system, prompt);
}

const TIMEOUT_MS = Number(env.NPC_TIMEOUT_MS || 60000); // a stuck model call must not hold an NPC forever

/** @param {string} system @param {string} prompt @param {string} [base] */
export async function viaApi(system, prompt, base = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.NPC_MODEL || 'claude-haiku-5-5', max_tokens: 200, system, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`model ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.content.map((c) => c.text || '').join('').trim();
}

/** @param {string} system @param {string} prompt @param {string} [base] */
export async function viaOllama(system, prompt, base = env.OLLAMA_URL || 'http://127.0.0.1:11434') {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model: env.NPC_MODEL || 'gemma4:e2b-it-qat', stream: false, think: false, options: { num_predict: 120 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`ollama ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return (j.message?.content || '').trim();
}

/** @param {string} system @param {string} prompt @returns {Promise<string>} */
function viaCli(system, prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--model', env.NPC_MODEL || 'haiku', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--disable-slash-commands', '--tools', '', '--no-session-persistence', '--system-prompt', system, prompt],
      { cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`cli exited ${code}`))));
  });
}
