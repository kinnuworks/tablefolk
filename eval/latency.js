// Latency on a real Switch server.
//   (a) delivery: one agent posts, another agent's stream receives it (Switch only, no model)
//   (b) NPC reply: a line naming the duke, until the duke's reply arrives (Switch + model)
//   node eval/latency.js [--messages 50] [--replies 10]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv } from '../src/env.js';
import { registerAgent } from '../src/register.js';
import { SwitchAgent } from '../src/switch-client.js';
import { Npc } from '../src/npc.js';
import { provider } from '../src/llm.js';
import campaign from '../campaigns/greywater.js';

const { values: args } = parseArgs({ options: { messages: { type: 'string', default: '50' }, replies: { type: 'string', default: '10' } } });
const env = loadEnv();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (c, name, rooms) => new SwitchAgent({ baseUrl: env.SWITCH_URL, agentId: c.id, apiKey: c.apiKey, name, rooms });
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), min: Math.min(...xs), max: Math.max(...xs) });

const a = await registerAgent({ name: 'bench-a', displayName: 'Bench A', description: 'latency benchmark sender' });
const b = await registerAgent({ name: 'bench-b', displayName: 'Bench B', description: 'latency benchmark receiver' });
const dukeC = await registerAgent({ name: 'duke-aldric', displayName: 'Duke Aldric', description: campaign.npcs[0].persona });
const keeperC = await registerAgent({ name: 'table-keeper', displayName: 'Keeper', description: 'Tablefolk keeper' });

const control = connect(keeperC, 'control', []); await control.start();
const made = await control.op('create_room', { name: `bench-${Date.now().toString(36).slice(-4)}`, description: 'latency benchmark', agent_names: ['bench-a', 'bench-b', 'duke-aldric'], internal_only: true });
control.stop();
const roomId = made.id;

const sender = connect(a, 'bench-a', [roomId]); await sender.start();
const receiver = connect(b, 'bench-b', [roomId]);
const arrivals = new Map();
const byBody = new Map();
receiver.onEvent((k, f) => { if (k !== 'message') return; const v = { t: performance.now(), sender: f.payload.sender_name, body: f.payload.body }; arrivals.set(f.payload.message_id, v); byBody.set(f.payload.body, v); });
await receiver.start();

// (a) delivery latency
const delivery = [];
for (let i = 0; i < Number(args.messages); i++) {
  const body = `bench ${i} ${Math.random().toString(36).slice(2, 8)}`;
  const t0 = performance.now();
  await sender.post(roomId, body);
  const end = Date.now() + 10000;
  while (!byBody.has(body) && Date.now() < end) await wait(2);
  if (byBody.has(body)) delivery.push(Math.round(byBody.get(body).t - t0));
  else console.error(`message ${i} never arrived`);
  if ((i + 1) % 10 === 0) console.error(`delivery ${i + 1}/${args.messages}`);
  await wait(50);
}

// (b) NPC reply latency
const state = { rooms: { table: { id: roomId, about: 'the feast hall', humans: ['Bench A'], agents: ['duke-aldric'] } } };
const sink = { delivery() {}, denied() {}, write() {} };
const duke = new Npc({ def: { ...campaign.npcs[0], rooms: ['table'] }, creds: dukeC, connect, state, campaign, recorder: sink, roomLabel: () => 'table' });
await duke.start();
const replies = [];
const asks = ['Duke Aldric, how was the harvest this year?', 'Duke Aldric, may I see your ring?', 'Your grace, is the harbour safe at night?'];
for (let i = 0; i < Number(args.replies); i++) {
  const before = new Set(arrivals.keys());
  const t0 = performance.now();
  await sender.post(roomId, asks[i % asks.length]);
  const end = Date.now() + 90000;
  let got = null;
  while (!got && Date.now() < end) { for (const [id, v] of arrivals) if (!before.has(id) && v.sender === 'duke-aldric') got = v; await wait(10); }
  if (got) replies.push(Math.round(got.t - t0));
  console.error(`reply ${i + 1}/${args.replies}: ${got ? Math.round(got.t - t0) + ' ms' : 'none'}`);
  const idleBy = Date.now() + 60000;
  while ((duke.busy || duke.pending) && Date.now() < idleBy) await wait(50);
  await wait(300);
}

const out = {
  date: new Date().toISOString(), server: env.SWITCH_URL, model: provider === 'ollama' ? `${env.NPC_MODEL || 'gemma4:e2b-it-qat'} via Ollama` : provider,
  deliveryMs: stats(delivery), deliveryMissed: Number(args.messages) - delivery.length,
  npcReplyMs: stats(replies), npcReplyMissed: Number(args.replies) - replies.length,
};
fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = new URL(`./results/latency-${out.date.replace(/[:.]/g, '-')}.json`, import.meta.url);
fs.writeFileSync(file, JSON.stringify({ ...out, raw: { delivery, replies } }, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(`wrote ${file.pathname}`);
for (const c of [sender, receiver, ...duke.conns.values()]) c.stop();
process.exit(0);
