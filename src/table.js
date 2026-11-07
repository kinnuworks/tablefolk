// Sets up a Tablefolk table on a Switch server and runs its agents.
//   node src/table.js --gm <switch user> --players <user,user> --rogue <user> [--campaign greywater]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv } from './env.js';
import { registerAgent } from './register.js';
import { SwitchAgent } from './switch-client.js';
import { Npc } from './npc.js';
import { Keeper } from './keeper.js';
import { Recorder } from './recorder.js';
import { provider } from './llm.js';

const env = loadEnv();
const { values: args } = parseArgs({ options: {
  campaign: { type: 'string', default: 'greywater' },
  gm: { type: 'string', default: '' },
  players: { type: 'string', default: '' },
  rogue: { type: 'string', default: '' },
  fresh: { type: 'boolean', default: false },
} });
const campaign = (await import(`../campaigns/${args.campaign}.js`)).default;
const players = args.players.split(',').map((s) => s.trim()).filter(Boolean);
const STATE = new URL(`../.table-${args.campaign}.json`, import.meta.url);

const connect = (creds, name, rooms) =>
  new SwitchAgent({ baseUrl: env.SWITCH_URL, agentId: creds.id, apiKey: creds.apiKey, name, rooms });

// 1. One Switch agent per character, plus the Keeper that runs dice and opens rooms.
const keeperCreds = await registerAgent({ name: 'table-keeper', displayName: 'Keeper', description: 'Tablefolk keeper: dice, hit points, and side rooms. No model, just code.' });
const npcCreds = {};
for (const n of campaign.npcs) npcCreds[n.name] = await registerAgent({ name: n.name, displayName: n.displayName, description: n.persona });

// 2. Rooms. Membership is the whole secrecy model: an NPC only hears rooms it is in.
let state = !args.fresh && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
const control = connect(keeperCreds, 'keeper-control', []);
await control.start();
if (!state) {
  state = { rooms: {}, startedAt: new Date().toISOString() };
  const tag = Date.now().toString(36).slice(-4);
  const template = new URL(`../templates/${args.campaign}.template.yaml`, import.meta.url);
  if (args.gm && args.rogue && fs.existsSync(template)) {
    // People are in the game: build the table from the Switch room template, as one linked group.
    const [player2 = '', player3 = ''] = players.filter((p) => p !== args.rogue);
    const made = await control.op('create_room_from_yaml', {
      yaml: fs.readFileSync(template, 'utf8'), inputs: { gm: args.gm, rogue: args.rogue, player2, player3, tag },
    });
    if (made.errors?.length) throw new Error(`template: ${JSON.stringify(made.errors)}`);
    for (const r of made.rooms) {
      const key = Object.keys(campaign.rooms).find((k) => r.room_name?.startsWith(`${campaign.rooms[k].title}-`));
      if (!key) continue;
      const room = campaign.rooms[key];
      const agents = ['table-keeper', ...campaign.npcs.filter((n) => n.rooms.includes(key)).map((n) => n.name)];
      const humans = room.humans.flatMap((h) => (h === 'gm' ? [args.gm] : h === 'players' ? players : h === 'rogue' ? [args.rogue] : [h]));
      state.rooms[key] = { id: r.room_id, name: r.room_name, title: room.title, about: room.about, agents, humans: [...new Set(humans)] };
      console.log(`room ${r.room_name}: agents ${agents.join(', ')}; people ${[...new Set(humans)].join(', ')}`);
    }
    console.log(`made from the Switch template "${args.campaign}" as group ${made.group_name}`);
  } else {
    // No people given: agent-only rooms, created one by one.
    for (const [key, room] of Object.entries(campaign.rooms)) {
      const agents = ['table-keeper', ...campaign.npcs.filter((n) => n.rooms.includes(key)).map((n) => n.name)];
      const made = await control.op('create_room', { name: `${room.title}-${tag}`, description: room.about, agent_names: agents, internal_only: true });
      state.rooms[key] = { id: made.id, name: made.name, title: room.title, about: room.about, agents, humans: [] };
      console.log(`room ${made.name}: agents ${agents.join(', ')}`);
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  state.fresh = true;
}
control.stop();

// 3. Run everyone. Each agent records exactly what its own streams delivered.
const recorder = new Recorder(campaign, state);
const roomLabel = (id) => Object.entries(state.rooms).find(([, r]) => r.id === id)?.[0] ?? id;

const keeper = new Keeper({ creds: keeperCreds, connect, state, campaign, recorder, roomLabel });
const npcs = campaign.npcs.map((def) => new Npc({ def, creds: npcCreds[def.name], connect, state, campaign, recorder, roomLabel }));
keeper.npcs = npcs;
await keeper.start();
for (const npc of npcs) await npc.start();
if (state.fresh) await keeper.say(state.rooms.table.id, `🕯️ ${campaign.title}. ${campaign.setting}\nName a character to talk to them. Dice: roll 1d20+3 · Hit points: hp Mira -4 · A private word: aside fen @you`);
console.log(`\nTable is live (${campaign.title}). NPC voices: ${provider}. Recording to ${recorder.file}`);
console.log('Talk in the rooms. Name an NPC to get a reply. roll 1d20+3 · hp Mira -4 · aside fen @rowan');
process.on('SIGINT', () => { recorder.close(); process.exit(0); });
