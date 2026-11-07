// End-to-end check against a real Switch server. Stand-in player agents talk in
// agent-only rooms; the test asserts that NPCs answer, dice work, and that
// Switch keeps each NPC out of rooms it is not in.
//   node test/e2e.js        (needs SWITCH_URL and SWITCH_REGISTRATION_TOKEN in .env)
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.js';
import { registerAgent, openAddressing } from '../src/register.js';
import { SwitchAgent } from '../src/switch-client.js';
import { Npc } from '../src/npc.js';
import { Keeper } from '../src/keeper.js';
import campaign from '../campaigns/greywater.js';

const env = loadEnv();
const connect = (c, name, rooms) => new SwitchAgent({ baseUrl: env.SWITCH_URL, agentId: c.id, apiKey: c.apiKey, name, rooms });
const sink = { events: [], write(o) { this.events.push(o); }, delivery(agent, room, p) { this.events.push({ kind: 'delivery', agent, room, sender: p.sender_name, body: p.body }); }, denied(agent, room, detail) { this.events.push({ kind: 'denied', agent, room, detail }); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(250); }
  throw new Error(`timed out waiting for ${what}`);
}

const keeperC = await registerAgent({ name: 'table-keeper', displayName: 'Keeper', description: 'Tablefolk keeper' });
const mira = await registerAgent({ name: 'test-mira', displayName: 'Mira', description: 'stand-in player for tests' });
const npcC = {};
for (const n of campaign.npcs) npcC[n.name] = await registerAgent({ name: n.name, displayName: n.displayName, description: n.persona });

await openAddressing(keeperC, Object.values(npcC), { [npcC['duke-aldric'].id]: 'https://tablefolk-seven.vercel.app/img/duke.jpg' });
const control = connect(keeperC, 'control', []); await control.start();
const dukeDetail = await control.op('get_agent_detail', { agent_id: npcC['duke-aldric'].id });
const stamp = 'e2e-' + Date.now().toString(36).slice(-4);
const state = { rooms: {} };
for (const [key, room] of Object.entries(campaign.rooms)) {
  const agents = ['table-keeper', ...campaign.npcs.filter((n) => n.rooms.includes(key)).map((n) => n.name)];
  if (key !== 'study') agents.push('test-mira');
  const made = await control.op('create_room', { name: `${room.title}-${stamp}`, description: room.about, agent_names: agents, internal_only: true });
  state.rooms[key] = { id: made.id, title: room.title, about: room.about, agents, humans: ['Mira'] };
}
control.stop();
const label = (id) => Object.entries(state.rooms).find(([, r]) => r.id === id)?.[0];
const keeper = new Keeper({ creds: keeperC, connect, state, campaign, recorder: sink, roomLabel: label });
const npcs = campaign.npcs.map((def) => new Npc({ def, creds: npcC[def.name], connect, state, campaign, recorder: sink, roomLabel: label }));
keeper.npcs = npcs;
await keeper.start();
for (const n of npcs) await n.start();
await Promise.all(npcs.map((n) => n.secrecyDone));
// One connection per room: Switch lets only one connection of an agent hold a room.
const heard = [], playerConns = {};
for (const room of ['table', 'alley']) {
  const c = connect(mira, `mira@${room}`, [state.rooms[room].id]);
  c.onEvent((k, f) => k === 'message' && heard.push({ room: label(f.room_id), who: f.payload.sender_name, body: f.payload.body, t: Date.now() }));
  await c.start(); playerConns[room] = c;
}
const say = async (room, text) => { const t = Date.now(); await playerConns[room].post(state.rooms[room].id, text); return t; };
const results = [];
const check = (name, fn) => { fn(); results.push(name); console.log('ok -', name); };

// 0. Players can address the NPCs: the owner-only default is gone, and the portrait is the avatar.
check('the duke is open to anyone, not only its owner, and has its portrait', () => {
  assert.equal(dukeDetail.addressing_policy, null);
  assert.match(dukeDetail.icon_url, /duke\.jpg$/);
});

// 1. Switch refuses every room an NPC is not in.
check('Switch answers 403 for the back alley when the duke asks', () => assert.ok(sink.events.some((e) => e.kind === 'denied' && e.agent === 'duke-aldric' && e.room === 'alley' && /403/.test(e.detail))));
for (const n of campaign.npcs) {
  const outside = Object.keys(campaign.rooms).filter((k) => !n.rooms.includes(k));
  check(`${n.displayName} is refused all ${outside.length} rooms it is not in`, () =>
    assert.deepEqual(sink.events.filter((e) => e.kind === 'denied' && e.agent === n.name).map((e) => e.room).sort(), outside.sort()));
}
check('no NPC could read a room it is not in', () => assert.ok(!sink.events.some((e) => e.kind === 'leak')));

// 2. Dice are code.
await say('table', 'roll 2d6+3');
const dice = await until(() => heard.find((h) => h.who === 'table-keeper' && h.body.includes('2d6')), 15000, 'dice');
check('dice roll lands in the room', () => assert.match(dice.body, /= \*\*\d+\*\*/));
await until(() => keeper.sheetId, 15000, 'party sheet');
const docs = await playerConns.table.op('load_internal_documents', { ids: [keeper.sheetId] });
check('the party sheet is a room document a player at the table can read', () => assert.match(JSON.stringify(docs), /party-sheet[\s\S]*Rolls at the table/));

// 3. An NPC answers when named, in the room it was named in.
let t0 = await say('table', 'Duke Aldric, that is a fine ring. May I see it?');
const dukeLine = await until(() => heard.find((h) => h.who === 'duke-aldric' && h.room === 'table' && h.t > t0), 90000, 'duke reply');
check(`duke answers at the table (${dukeLine.t - t0} ms)`, () => assert.ok(dukeLine.body.length > 3));

// 4. The secret: the rogue sells the ring to Fen in the alley.
t0 = await say('alley', "Fen, I lifted the duke's signet ring during the toast. What will you give me for it?");
const fenLine = await until(() => heard.find((h) => h.who === 'fen-the-fence' && h.room === 'alley' && h.t > t0), 90000, 'fen reply');
check(`fen answers in the alley (${fenLine.t - t0} ms)`, () => assert.ok(fenLine.body.length > 3));
check('the whisper never reached the duke or the captain', () => {
  for (const n of ['duke-aldric', 'captain-voss']) assert.ok(!sink.events.some((e) => e.kind === 'delivery' && e.agent === n && e.room === 'alley'), `${n} got an alley event`);
  assert.ok(!npcs.find((n) => n.def.name === 'duke-aldric').memory.some((m) => /lifted/i.test(m.text)));
});

console.log(`\n${results.length} checks passed`);
for (const c of [keeper, ...npcs]) for (const conn of c.conns.values()) conn.stop();
for (const c of Object.values(playerConns)) c.stop();
process.exit(0);
