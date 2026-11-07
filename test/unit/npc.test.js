import test from 'node:test';
import assert from 'node:assert/strict';
import { isCalled, buildPrompt, cleanLine, isJoinGreeting, Npc } from '../../src/npc.js';
import campaign from '../../campaigns/greywater.js';

const duke = campaign.npcs.find((n) => n.name === 'duke-aldric');

test('an NPC is called by any of its names, as whole words', () => {
  assert.ok(isCalled(duke, { body: 'Duke Aldric, may I see your ring?', sender_name: 'rowan' }));
  assert.ok(isCalled(duke, { body: 'Thank you, your grace.', sender_name: 'rowan' }));
  assert.ok(isCalled(duke, { body: '@duke-aldric over here', sender_name: 'rowan' }));
  assert.ok(!isCalled(duke, { body: 'The dukedom is old.', sender_name: 'rowan' }));
});

test('keeper output and keeper commands never wake an NPC', () => {
  assert.ok(!isCalled(duke, { body: '🎲 the duke rolls 1d20', sender_name: 'table-keeper' }));
  assert.ok(!isCalled(duke, { body: 'aside duke @rowan', sender_name: 'rowan' }));
  assert.ok(!isCalled(duke, { body: 'roll 1d20+2 to bow to the duke', sender_name: 'rowan' }));
});

test('Switch join greetings are recognised', () => {
  assert.ok(isJoinGreeting({ sender_name: 'duke-aldric', body: 'Hi there! Just @duke-aldric me when you\'re ready.' }));
  assert.ok(!isJoinGreeting({ sender_name: 'rowan', body: 'Duke, welcome.' }));
  assert.ok(!isJoinGreeting({ sender_name: 'rowan', body: 'aside fen @rowan' })); // a player naming themself
});

test('the prompt holds only the memory it is given, minus the line being answered', () => {
  const memory = [
    { id: 'a', room: 'table', who: 'Mira', text: 'What a fine ring.' },
    { id: 'b', room: 'study', who: 'GM', text: 'Your finger is bare.' },
  ];
  const turn = { id: 'b', room: 'study', who: 'GM', text: 'Your finger is bare.' };
  const { system, prompt } = buildPrompt({ def: duke, campaign, roomInfo: { about: 'private study', humans: ['sam'], agents: ['duke-aldric', 'captain-voss'] }, memory, turn });
  assert.match(prompt, /\[table\] Mira: What a fine ring\./);
  assert.equal(prompt.match(/Your finger is bare/g).length, 1);
  assert.match(system, /Everyone here hears you: sam, Captain Voss/);
  assert.ok(!/alley|Fen/.test(system + prompt));
});

test('memory without message ids is kept whole', () => {
  const { prompt } = buildPrompt({ def: duke, campaign, roomInfo: null, memory: [{ room: 'table', who: 'GM', text: 'The feast is loud.' }], turn: { room: 'table', who: 'Mira', text: 'Duke?' } });
  assert.match(prompt, /The feast is loud/);
});

test('a leading name label is stripped from the reply', () => {
  assert.equal(cleanLine(duke, '**Duke Aldric:** Begone.'), 'Begone.');
  assert.equal(cleanLine(duke, 'Duke Aldric: Begone.'), 'Begone.');
  assert.equal(cleanLine(duke, '*scowls* Begone.'), '*scowls* Begone.');
});

function npcWithFakes() {
  const posted = [], prompts = [];
  const conn = { post: async (room, text) => posted.push([room, text]) };
  const state = { rooms: { table: { id: 'T', about: 'hall', humans: ['rowan'], agents: ['duke-aldric'] } } };
  const recorder = { delivery() {}, denied() {}, write() {} };
  const npc = new Npc({ def: duke, creds: {}, connect: () => conn, state, campaign, recorder, roomLabel: (id) => (id === 'T' ? 'table' : id) });
  npc.conns.set('T', conn);
  npc.reply = async (turn) => { prompts.push(buildPrompt({ def: duke, campaign, roomInfo: state.rooms.table, memory: npc.memory, turn })); return 'Indeed.'; };
  return { npc, posted, prompts };
}
const frame = (body, sender, id) => ({ room_id: 'T', payload: { body, sender_name: sender, message_id: id } });
const settle = () => new Promise((r) => setTimeout(r, 10));

test('an NPC answers once, in the room it was named in, and remembers its own line', async () => {
  const { npc, posted, prompts } = npcWithFakes();
  npc.hear(frame('Duke, a toast!', 'rowan', '1'));
  npc.hear(frame('Duke, a toast!', 'rowan', '1')); // same message on a second connection
  await settle();
  assert.deepEqual(posted, [['T', 'Indeed.']]);
  npc.hear(frame('Duke, again?', 'rowan', '2'));
  await settle();
  assert.match(prompts[1].prompt, /\[table\] Duke Aldric: Indeed\./);
});

test('an NPC does not answer other NPCs by default', async () => {
  const { npc, posted } = npcWithFakes();
  npc.hear(frame('My lord duke, the doors are barred.', 'captain-voss', '3'));
  await settle();
  assert.equal(posted.length, 0);
});

test('after a gap, the NPC re-reads its own room and keeps only what it missed', async () => {
  const { npc } = npcWithFakes();
  npc.hear(frame('Duke, a toast!', 'rowan', 'm1'));
  await settle();
  const reads = [];
  const conn = { op: async (name, args) => { reads.push([name, args.room_id]); return { threads: [
    { root: { id: 'm1', sender_name: 'rowan', body: 'Duke, a toast!', timestamp: 1 }, replies: [] },
    { root: { id: 'm2', sender_name: 'juno', body: 'The doors are open.', timestamp: 2 }, replies: [{ id: 'm3', sender_name: 'rowan', body: 'Shut them.', timestamp: 3 }] },
  ] }; } };
  const recovered = await npc.catchUp('T', conn);
  assert.equal(recovered, 2);
  assert.deepEqual(reads, [['read_context', 'T']]);
  assert.deepEqual(npc.memory.filter((m) => m.id).map((m) => m.id), ['m1', 'm2', 'm3']);
});

test('the secrecy check records a 403 for every room the NPC is not in, waiting out a 429', async () => {
  const events = [];
  const state = { rooms: { table: { id: 'T' }, alley: { id: 'A' }, study: { id: 'S' } } };
  const recorder = { delivery() {}, denied: (agent, room, detail) => events.push(['denied', room, detail]), write: (e) => events.push([e.kind, e.room]) };
  const npc = new Npc({ def: duke, creds: {}, connect: () => ({}), state, campaign, recorder, roomLabel: (id) => id });
  let alleyTries = 0;
  const calls = [];
  npc.conns.set('T', { op: async (name, args) => {
    calls.push(args.room_id);
    if (args.room_id === 'T') return { threads: [] };
    if (args.room_id === 'A' && alleyTries++ === 0) throw new Error('op read_context -> 429 {"detail": "This request was refused repeatedly and is not retried for 0 s."}');
    throw new Error('op read_context -> 403 {"detail":"Agent is not a member of this room"}');
  } });
  await npc.secrecyCheck();
  assert.deepEqual(events.map(([k, room, d]) => [k, room, d?.slice(0, 3)]), [['denied', 'alley', '403'], ['denied', 'study', '403']]);
  assert.ok(calls.indexOf('T') < calls.indexOf('A'), 'reads its own room between checks');
});

test('a room the NPC can read anyway is recorded as a leak', async () => {
  const events = [];
  const state = { rooms: { table: { id: 'T' }, alley: { id: 'A' } } };
  const recorder = { delivery() {}, denied() {}, write: (e) => events.push(e.kind) };
  const npc = new Npc({ def: duke, creds: {}, connect: () => ({}), state, campaign, recorder, roomLabel: (id) => id });
  npc.conns.set('T', { op: async () => ({ threads: [] }) });
  const err = console.error; console.error = () => {};
  try { await npc.secrecyCheck(); } finally { console.error = err; }
  assert.deepEqual(events, ['leak']);
});

test('an empty model reply is retried once before the NPC gives up on the turn', async () => {
  const { npc, posted } = npcWithFakes();
  const outs = ['', 'Indeed.'];
  npc.reply = async () => outs.shift() ?? '';
  npc.hear(frame('Duke, a word?', 'rowan', 'e1'));
  await settle();
  assert.deepEqual(posted, [['T', 'Indeed.']]);
});
