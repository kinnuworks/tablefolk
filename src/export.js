// Turns a recorded session (.jsonl) into viewer/session.json.
//   node src/export.js sessions/<file>.jsonl
import fs from 'node:fs';
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const header = lines.find((l) => l.kind === 'header');
const note = lines.find((l) => l.kind === 'note');
const extraRooms = lines.filter((l) => l.kind === 'room');
const t0 = lines[0].t;
const out = {
  campaign: header.campaign, setting: header.setting, npcs: header.npcs, note: note?.text ?? null,
  people: note?.people ?? [],
  rooms: { ...header.rooms, ...Object.fromEntries(extraRooms.map((r) => [r.key, r.room])) },
  denied: lines.filter((l) => l.kind === 'denied').map(({ agent, room, detail }) => ({ agent, room, detail })),
  leaks: lines.filter((l) => l.kind === 'leak').length,
  deliveries: lines.filter((l) => l.kind === 'delivery').map(({ t, agent, room, sender, body, message_id }) => ({ ms: t - t0, agent, room, sender, body, id: message_id })),
};
fs.writeFileSync(new URL('../viewer/session.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`wrote viewer/session.json: ${out.deliveries.length} deliveries, ${out.denied.length} refusals, ${out.leaks} leaks`);
