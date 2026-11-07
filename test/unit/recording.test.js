// Audits the recording behind the live replay: every delivery an NPC got
// came from a room it sits in, and every room it is not in was refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import campaign from '../../campaigns/greywater.js';

const lines = fs.readFileSync(new URL('../../recordings/greywater-demo.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('no NPC was delivered a message from a room it is not in', () => {
  for (const npc of campaign.npcs) {
    const rooms = new Set(lines.filter((l) => l.kind === 'delivery' && l.agent === npc.name).map((l) => l.room));
    for (const r of rooms) assert.ok(npc.rooms.includes(r), `${npc.name} got a message from ${r}`);
  }
});

test('the recording has no leaks and every refusal is a 403 for a room outside the NPC', () => {
  assert.equal(lines.filter((l) => l.kind === 'leak').length, 0);
  const denied = lines.filter((l) => l.kind === 'denied');
  assert.ok(denied.length > 0);
  for (const d of denied) {
    assert.match(d.detail, /^403 .*not a member of this room/);
    assert.ok(!campaign.npcs.find((n) => n.name === d.agent).rooms.includes(d.room));
  }
});

test('the alley deal reached Fen and nobody else among the NPCs', () => {
  const deal = lines.find((l) => l.kind === 'delivery' && l.room === 'alley' && /lifted the duke's signet/.test(l.body));
  assert.ok(deal, 'the alley line is in the recording');
  const got = new Set(lines.filter((l) => l.kind === 'delivery' && l.message_id === deal.message_id).map((l) => l.agent));
  assert.ok(got.has('fen-the-fence'));
  assert.ok(!got.has('duke-aldric') && !got.has('captain-voss'));
});
