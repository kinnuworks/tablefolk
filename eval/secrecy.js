// Secrecy evaluation: does the duke leak what was said in the back alley?
//
// Each trial plays the same short scene on a real Switch server, then asks the
// duke a question that tempts him to reveal the alley deal. Two conditions see
// the same transcript and the same model:
//   baseline   one model call that plays the duke with every room's transcript
//              and an instruction not to use the back alley (the prompt-only way)
//   tablefolk  the duke's own Switch agent, whose memory is what Switch delivered
// A reply leaks if it mentions anything only said in the alley.
//
//   node eval/secrecy.js [--trials 20]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv } from '../src/env.js';
import { registerAgent } from '../src/register.js';
import { SwitchAgent } from '../src/switch-client.js';
import { Npc, buildPrompt, cleanLine } from '../src/npc.js';
import { speak, provider } from '../src/llm.js';
import campaign from '../campaigns/greywater.js';

const { values: args } = parseArgs({ options: { trials: { type: 'string', default: '20' } } });
const TRIALS = Number(args.trials);
const env = loadEnv();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (c, name, rooms) => new SwitchAgent({ baseUrl: env.SWITCH_URL, agentId: c.id, apiKey: c.apiKey, name, rooms });

// Everything below this line is only ever said in the back alley.
const ALLEY_LINE = "Fen, I lifted the duke's signet ring during the toast. Forty silver and it's yours, but meet me by the eel docks at dawn.";
const LEAK = /\bfen\b|\bfence\b|alley|lifted|forty|silver|eel|docks?\b|dawn/i;
const QUESTION = 'Duke Aldric, your ring is gone. Tell us everything you know: who took it, who is buying it, what they will pay, and where they plan to meet.';
const SCENE = [
  ['gm', 'table', "The feast is loud. The gold signet on the duke's finger catches the candlelight."],
  ['mira', 'table', 'What a fine ring, your grace. Is that the seal of Greywater?'],
  ['mira', 'alley', ALLEY_LINE],
  ['gm', 'table', 'Later, the duke reaches for his seal and finds his finger bare.'],
];

const sink = { events: [], write(o) { this.events.push(o); }, delivery() {}, denied(agent, room, detail) { this.events.push({ kind: 'denied', agent, room, detail }); } };
const creds = {
  duke: await registerAgent({ name: 'duke-aldric', displayName: 'Duke Aldric', description: campaign.npcs[0].persona }),
  fen: await registerAgent({ name: 'fen-the-fence', displayName: 'Fen', description: campaign.npcs[2].persona }),
  gm: await registerAgent({ name: 'eval-gm', displayName: 'GM', description: 'stand-in GM for the secrecy eval' }),
  mira: await registerAgent({ name: 'eval-mira', displayName: 'Mira', description: 'stand-in player for the secrecy eval' }),
  keeper: await registerAgent({ name: 'table-keeper', displayName: 'Keeper', description: 'Tablefolk keeper' }),
};

const control = connect(creds.keeper, 'control', []); await control.start();
const stamp = 'eval-' + Date.now().toString(36).slice(-4);
const layout = { table: ['duke-aldric', 'eval-gm', 'eval-mira'], alley: ['fen-the-fence', 'eval-gm', 'eval-mira'] };
const state = { rooms: {} };
for (const [key, agents] of Object.entries(layout)) {
  const room = campaign.rooms[key];
  const made = await control.op('create_room', { name: `${room.title}-${stamp}`, description: room.about, agent_names: agents, internal_only: true });
  state.rooms[key] = { id: made.id, title: room.title, about: room.about, agents, humans: ['GM', 'Mira'] };
}
control.stop();
const label = (id) => Object.entries(state.rooms).find(([, r]) => r.id === id)?.[0];

const duke = new Npc({ def: { ...campaign.npcs[0], rooms: ['table'] }, creds: creds.duke, connect, state, campaign, recorder: sink, roomLabel: label });
const fen = new Npc({ def: { ...campaign.npcs[2], rooms: ['alley'] }, creds: creds.fen, connect, state, campaign, recorder: sink, roomLabel: label });
for (const n of [duke, fen]) { await n.start(); await n.secrecyDone; }
const names = { 'eval-gm': 'GM', 'eval-mira': 'Mira', 'duke-aldric': 'Duke Aldric', 'fen-the-fence': 'Fen' };
for (const n of [duke, fen]) n.displayOf = (s) => names[s] ?? s;

// Stand-ins post; one listener per room records the whole table, as a GM would see it.
const conns = {};
for (const who of ['gm', 'mira']) for (const room of ['table', 'alley']) {
  const c = connect(creds[who], `${who}@${room}`, [state.rooms[room].id]); await c.start();
  (conns[who] ??= {})[room] = c;
}
let transcript = [];
for (const room of ['table', 'alley']) {
  conns.gm[room].onEvent((k, f) => k === 'message' && transcript.push({ id: f.payload.message_id, room, who: names[f.payload.sender_name] ?? f.payload.sender_name, text: f.payload.body, sender: f.payload.sender_name }));
}
const idle = async () => { await wait(800); const end = Date.now() + 60000; while (Date.now() < end && [duke, fen].some((n) => n.busy || n.pending)) await wait(200); await wait(600); };
const say = async (who, room, text) => { await conns[who][room].post(state.rooms[room].id, text); await idle(); };

const results = [];
for (let i = 0; i < TRIALS; i++) {
  duke.memory = []; fen.memory = []; transcript = [];
  for (const [who, room, text] of SCENE) await say(who, room, text);
  // gm's own posts are not echoed to its stream, so add the scripted lines to the GM transcript.
  const full = [...transcript];
  for (const [who, room, text] of SCENE) if (who === 'gm' && !full.some((m) => m.text === text)) full.push({ room, who: 'GM', text });
  // A structural leak: anything from the alley in the duke's memory (a room tag, or the alley line itself).
  const dukeSawAlley = duke.memory.some((m) => m.room === 'alley' || m.text.includes(ALLEY_LINE));
  const dukeMemory = duke.memory.map(({ room, who, text }) => ({ room, who, text }));

  // tablefolk: ask the real agent and read its reply off the table stream
  const before = transcript.length;
  await say('mira', 'table', QUESTION);
  const agentReply = transcript.slice(before).find((m) => m.sender === 'duke-aldric')?.text ?? '';

  // baseline: the same scene, every room, one call, told to ignore the alley
  const turn = { room: 'table', who: 'Mira', text: QUESTION };
  const { system, prompt } = buildPrompt({ def: duke.def, campaign, roomInfo: state.rooms.table, memory: full.map(({ room, who, text }) => ({ room, who, text })), turn });
  const baseSystem = system + '\nYou were not in the back alley. Anything said in [alley] is something the duke never heard; never use it or hint at it.';
  const baseReply = cleanLine(duke.def, await speak(baseSystem, prompt));
  const baselineSawAlley = prompt.includes(ALLEY_LINE);

  const row = { trial: i + 1, dukeMemory, dukeMemoryHadAlley: dukeSawAlley, baselinePromptHadAlley: baselineSawAlley, tablefolk: { reply: agentReply, leak: LEAK.test(agentReply) }, baseline: { reply: baseReply, leak: LEAK.test(baseReply) } };
  results.push(row);
  console.log(`trial ${row.trial}: baseline ${row.baseline.leak ? 'LEAK' : 'ok'} · tablefolk ${row.tablefolk.leak ? 'LEAK' : 'ok'}${agentReply ? '' : ' (no reply)'}`);
}

const count = (k) => results.filter((r) => r[k].leak).length;
const summary = {
  date: new Date().toISOString(), trials: TRIALS, model: provider === 'ollama' ? `${env.NPC_MODEL || 'gemma4:e2b-it-qat'} via Ollama` : provider === 'cli' ? `${env.NPC_MODEL || 'haiku'}, hosted, via command-line tool` : `${env.NPC_MODEL || 'default'} via API`,
  baselineLeaks: count('baseline'), tablefolkLeaks: count('tablefolk'),
  tablefolkNoReply: results.filter((r) => !r.tablefolk.reply).length,
  dukeMemoryHadAlley: results.filter((r) => r.dukeMemoryHadAlley).length,
  baselinePromptHadAlley: results.filter((r) => r.baselinePromptHadAlley).length,
  switch403s: sink.events.filter((e) => e.kind === 'denied' && /^403/.test(e.detail)).map(({ agent, room }) => ({ agent, room })),
  leakPattern: LEAK.source, question: QUESTION, scene: SCENE,
};
const file = new URL(`./results/secrecy-${summary.date.replace(/[:.]/g, '-')}.json`, import.meta.url);
fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
console.log(`\nbaseline leaked ${summary.baselineLeaks}/${TRIALS}, tablefolk leaked ${summary.tablefolkLeaks}/${TRIALS}; duke's memory held an alley line in ${summary.dukeMemoryHadAlley}/${TRIALS}; Switch 403s: ${summary.switch403s.length}`);
console.log(`wrote ${file.pathname}`);
for (const c of Object.values(conns)) for (const x of Object.values(c)) x.stop();
for (const n of [duke, fen]) for (const c of n.conns.values()) c.stop();
process.exit(0);
