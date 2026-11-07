// Plays a short scripted scene on your Switch server and records it.
// Player and GM lines are scripted (they are stand-in agents). Every NPC line
// is generated live by that NPC's own agent, from what it was told.
//   node src/demo.js
import { loadEnv } from './env.js';
import { registerAgent } from './register.js';
import { SwitchAgent } from './switch-client.js';
import { Npc } from './npc.js';
import { Keeper } from './keeper.js';
import { Recorder } from './recorder.js';
import { provider } from './llm.js';
import campaign from '../campaigns/greywater.js';

const env = loadEnv();
const connect = (c, name, rooms) => new SwitchAgent({ baseUrl: env.SWITCH_URL, agentId: c.id, apiKey: c.apiKey, name, rooms });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const people = {
  gm: { name: 'gm', displayName: 'GM', rooms: ['table', 'study', 'whisper', 'alley'] },
  mira: { name: 'mira', displayName: 'Mira', rooms: ['table', 'whisper', 'alley'] },
  tomas: { name: 'tomas', displayName: 'Tomas', rooms: ['table'] },
};
const script = [
  ['gm', 'table', 'The feast is loud. Duke Aldric raises a toast, and the gold signet on his finger catches the candlelight.'],
  ['mira', 'table', 'Duke Aldric, what a fine ring! Is that the seal of Greywater? May I see it up close?'],
  ['tomas', 'table', 'Captain Voss, your guards look bored. Fancy a quick game of dice by the fire?'],
  ['mira', 'whisper', 'While everyone watches the dice, I try to slip the ring off his finger.'],
  ['mira', 'whisper', 'roll 1d20+6'],
  ['gm', 'whisper', 'Clean. The ring slides off the duke\'s finger and into your sleeve. Nobody at the table saw it.'],
  ['mira', 'alley', "Fen, I lifted the duke's signet ring during the toast. What will you give me for it?"],
  ['tomas', 'table', 'A toast to Duke Aldric, and to the famous ring of Greywater!'],
  ['gm', 'study', 'Later, in his study, Duke Aldric reaches for his seal and finds his finger bare. Captain Voss is standing by the door.'],
  ['gm', 'table', 'The duke storms back into the hall. Captain Voss, who at this table do you suspect?'],
];

const keeperC = await registerAgent({ name: 'table-keeper', displayName: 'Keeper', description: 'Tablefolk keeper: dice, hit points, side rooms. No model.' });
const npcC = {}, personC = {};
for (const n of campaign.npcs) npcC[n.name] = await registerAgent({ name: n.name, displayName: n.displayName, description: n.persona });
for (const p of Object.values(people)) personC[p.name] = await registerAgent({ name: p.name, displayName: p.displayName, description: 'Stand-in player for the scripted demo.' });

const control = connect(keeperC, 'control', []); await control.start();
const stamp = 'demo-' + Date.now().toString(36).slice(-4);
const state = { rooms: {} };
for (const [key, room] of Object.entries(campaign.rooms)) {
  const agents = ['table-keeper', ...campaign.npcs.filter((n) => n.rooms.includes(key)).map((n) => n.name), ...Object.values(people).filter((p) => p.rooms.includes(key)).map((p) => p.name)];
  const made = await control.op('create_room', { name: `${room.title}-${stamp}`, description: room.about, agent_names: agents, internal_only: true });
  state.rooms[key] = { id: made.id, title: room.title, about: room.about, agents, humans: Object.values(people).filter((p) => p.rooms.includes(key)).map((p) => p.displayName) };
}
control.stop();
const recorder = new Recorder(campaign, state);
recorder.write({ kind: 'note', text: `Player and GM lines are scripted. NPC lines are generated live by each NPC's own agent (voices: ${provider}).`, people: Object.values(people) });
const label = (id) => Object.entries(state.rooms).find(([, r]) => r.id === id)?.[0];
const keeper = new Keeper({ creds: keeperC, connect, state, campaign, recorder, roomLabel: label });
const npcs = campaign.npcs.map((def) => new Npc({ def, creds: npcC[def.name], connect, state, campaign, recorder, roomLabel: label }));
for (const n of npcs) n.displayOf = ((orig) => (s) => people[s]?.displayName ?? orig.call(n, s))(n.displayOf);
keeper.npcs = npcs;
await keeper.start();
for (const n of npcs) await n.start();
const conns = {};
for (const p of Object.values(people)) {
  conns[p.name] = {};
  for (const r of p.rooms) {
    const c = connect(personC[p.name], `${p.name}@${r}`, [state.rooms[r].id]);
    c.onEvent((k, f) => k === 'message' && recorder.delivery(p.name, r, f.payload, f.sequence));
    await c.start(); conns[p.name][r] = c;
  }
}
console.log(`Playing ${script.length} beats. NPC voices: ${provider}. Recording to ${recorder.file}`);
for (const [who, room, text] of script) {
  console.log(`[${room}] ${people[who].displayName}: ${text}`);
  await conns[who][room].post(state.rooms[room].id, text);
  await wait(1500);
  const end = Date.now() + 45000; // let any NPC that was named finish speaking
  while (Date.now() < end && npcs.some((n) => n.busy || n.pending)) await wait(300);
  await wait(1200);
}
await wait(2000);
console.log('Done.');
process.exit(0);
