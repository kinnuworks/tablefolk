import test from 'node:test';
import assert from 'node:assert/strict';
import { roll, Keeper } from '../../src/keeper.js';
import campaign from '../../campaigns/greywater.js';

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('roll parses count, sides and modifier', () => {
  const r = roll('roll 2d6+3', seq(0, 0.99));
  assert.deepEqual(r, { n: 2, sides: 6, mod: 3, rolls: [1, 6], total: 10 });
});

test('roll handles a bare die and a negative modifier', () => {
  assert.equal(roll('roll d20', seq(0.5)).total, 11);
  assert.equal(roll('roll 1d20 - 2', seq(0)).total, -1);
});

test('roll ignores ordinary sentences and caps huge pools', () => {
  assert.equal(roll('roll the barrel over'), null);
  assert.equal(roll('!roll 1d20'), null); // Switch owns the ! prefix
  assert.equal(roll('roll 500d6', seq(0)).n, 20);
});

function keeperWithFakeRoom() {
  const said = [];
  const ops = [];
  const conn = { post: async (room, text) => said.push([room, text]), op: async (name, args) => { ops.push([name, args]); return { id: 'new-room', name: args.name }; } };
  const state = { rooms: { table: { id: 'T', humans: ['sam'], agents: [] } } };
  const recorder = { delivery() {}, write() {} };
  const k = new Keeper({ creds: {}, connect: () => conn, state, campaign, recorder, roomLabel: (id) => (id === 'T' ? 'table' : id) });
  k.conns.set('T', conn);
  k.join = async (id) => k.conns.set(id, conn);
  return { k, said, ops, state };
}

const msg = (body, sender = 'rowan', id = Math.random().toString(36)) => ({ room_id: 'T', payload: { body, sender_name: sender, message_id: id } });

test('the keeper answers a roll in the same room', async () => {
  const { k, said } = keeperWithFakeRoom();
  await k.hear(msg('roll 1d20+6'));
  assert.equal(said.length, 1);
  assert.equal(said[0][0], 'T');
  assert.match(said[0][1], /^🎲 rowan rolls 1d20 \+ 6: \[\d+\] \+ 6 = \*\*\d+\*\*$/);
});

test('hit points start at 20, change, and floor at zero', async () => {
  const { k, said } = keeperWithFakeRoom();
  await k.hear(msg('hp Mira -4'));
  await k.hear(msg('hp Mira -30'));
  await k.hear(msg('hp'));
  assert.match(said[0][1], /Mira: 20 → \*\*16\*\*/);
  assert.match(said[1][1], /\*\*0\*\* \(down!\)/);
  assert.match(said[2][1], /Mira 0/);
});

test('table rolls and hit points go on the party sheet; private rolls do not', async () => {
  const { k, ops } = keeperWithFakeRoom();
  ops.length = 0;
  const conn = k.conns.get('T');
  conn.op = async (name, args) => { ops.push([name, args]); return { document_id: 'doc-1' }; };
  k.conns.set('W', conn); k.state.rooms.whisper = { id: 'W', humans: [], agents: [] };
  await k.hear(msg('roll 1d20+3'));
  await k.hear(msg('hp Mira -4'));
  await k.hear({ room_id: 'W', payload: { body: 'roll 1d20+6', sender_name: 'rowan', message_id: 'w1' } });
  assert.deepEqual(ops.map(([n]) => n), ['create_room_document', 'update_room_document']);
  const sheet = ops.at(-1)[1].content;
  assert.match(sheet, /- Mira: 16/);
  assert.match(sheet, /rowan rolls 1d20 \+ 3/);
  assert.ok(!/1d20 \+ 6/.test(sheet));
});

test('aside opens a private room with the NPC, the player and the GM', async () => {
  const { k, said, ops, state } = keeperWithFakeRoom();
  const joined = [];
  k.npcs = [{ def: campaign.npcs.find((n) => n.name === 'fen-the-fence'), join: async (id) => joined.push(id) }];
  await k.hear(msg('aside fen @rowan'));
  const [name, args] = ops[0];
  assert.equal(name, 'create_room');
  assert.equal(args.channel_type, 'channel_private');
  assert.deepEqual(args.agent_names, ['table-keeper', 'fen-the-fence']);
  assert.deepEqual(args.user_names, ['sam', 'rowan']);
  assert.deepEqual(joined, ['new-room']);
  assert.ok(Object.values(state.rooms).some((r) => r.id === 'new-room'));
  assert.match(said.at(-1)[1], /Only the people in this room hear this/);
});

test('the keeper handles each message once even if two connections deliver it', async () => {
  const { k, said } = keeperWithFakeRoom();
  const m = msg('roll 1d4', 'rowan', 'same-id');
  await k.hear(m); await k.hear(m);
  assert.equal(said.length, 1);
});
