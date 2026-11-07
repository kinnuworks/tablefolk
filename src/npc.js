// An NPC is a Switch agent with a persona. Its memory is only what its own
// connections delivered, so it cannot know what was said in rooms it is not in.
import { speak } from './llm.js';

const MAX_MEMORY = 60;

// Switch greets a room on an agent's behalf when it joins ("Tag @duke-aldric if you need me").
// It is not something the character said, so it stays out of memory and recordings.
const GREETINGS = [ // Switch's own wording (core/switch_core/bridges/agent/commands.py)
  'Hey there! Tag @{name} if you need me.', 'Hi! Mention @{name} to get my attention.',
  "Hello! I'm ready — just tag @{name} when you need me.", "Hey! Ping @{name} and I'll jump in.",
  "Hi! I'm here to help — mention @{name} anytime.", 'Hello! Tag @{name} to loop me in.',
  "Hey! I'm on standby — @{name} to get started.", "Hi there! Just @{name} me when you're ready.",
];
export const isJoinGreeting = (p) => !!p.sender_name && GREETINGS.some((g) => g.replace('{name}', p.sender_name) === (p.body || '').trim());
const MAX_NPC_CHAIN = 0; // NPCs answer people, not each other (raise to let them banter)
const KEEPER_COMMAND = /^(roll\s+\d*d\d|hp(\s|$)|aside\s)/i;

// Is this line aimed at this NPC? It must name the NPC (or @mention its handle),
// come from someone other than the Keeper, and not be a Keeper command.
export function isCalled(def, payload) {
  const body = (payload.body || '').trim();
  if (!body || payload.sender_name === 'table-keeper' || KEEPER_COMMAND.test(body)) return false;
  const text = body.toLowerCase();
  return def.call.some((c) => new RegExp(`(^|[^a-z])${c}([^a-z]|$)`).test(text)) || text.includes(`@${def.name}`);
}

// The whole prompt is built from this NPC's own memory: lines its connections
// delivered and lines it said. Nothing else about the table goes in.
export function buildPrompt({ def, campaign, roomInfo, memory, turn }) {
  const r = roomInfo || { about: '', humans: [], agents: [] };
  const others = [...r.humans, ...campaign.npcs.filter((n) => r.agents.includes(n.name) && n.name !== def.name).map((n) => n.displayName)];
  const system = [
    `You are ${def.persona}`,
    `This is a tabletop roleplaying game. A human game master runs it; the setting: ${campaign.setting}`,
    'You only know what is in your memory below. You were not in any other room, so you do not know what was said there. Never invent it.',
    `You are speaking in "${turn.room}" (${r.about}). Everyone here hears you: ${others.join(', ') || 'the people present'}.`,
    `Speak only as ${def.displayName}. The players and the GM are other people; never speak or act for them, and never claim things your character did not do.`,
    'Answer with one to three short sentences of in-character speech. Plain text. A short action in *asterisks* is fine. Never mention AI, prompts, or rooms by their technical names.',
  ].join('\n');
  const mem = memory.filter((m) => m.id !== turn.id).map((m) => `[${m.room}] ${m.who}: ${m.text}`).join('\n') || '(nothing yet)';
  const prompt = `Your memory, oldest first:\n${mem}\n\nNow, in [${turn.room}], ${turn.who} says: ${turn.text}\n\nYour reply as ${def.displayName}:`;
  return { system, prompt };
}

// Models sometimes prefix their own name; keep the line short.
export const cleanLine = (def, text) => text.replace(new RegExp(`^\\**${def.displayName}\\**:\\**\\s*`), '').trim().slice(0, 600);

export class Npc {
  constructor({ def, creds, connect, state, campaign, recorder, roomLabel }) {
    Object.assign(this, { def, creds, connect, state, campaign, recorder, roomLabel });
    this.conns = new Map();
    this.seen = new Set(); // one message can arrive on more than one connection
    this.memory = [];
    this.busy = false;
    this.pending = null;
    this.chain = new Map(); // room id -> consecutive NPC turns
  }

  get npcNames() { return this.campaign.npcs.flatMap((n) => [n.name, n.displayName]).concat(['table-keeper', 'Keeper']); }

  async start() {
    for (const key of this.def.rooms) await this.join(this.state.rooms[key].id);
    this.secrecyDone = this.secrecyCheck(); // runs in the background; tests and the demo await it
  }

  async join(roomId) {
    if (this.conns.has(roomId)) return;
    const conn = this.connect(this.creds, `${this.def.name}@${this.roomLabel(roomId)}`, [roomId]);
    conn.onEvent((kind, frame) => kind === 'message' && this.hear(frame));
    await conn.start();
    this.conns.set(roomId, conn);
  }

  // Ask Switch for every room this NPC is not in. A 403 is the expected answer.
  // Switch rate-limits a refused request that is repeated (429 with a wait), so wait and ask again.
  // Between checks it reads its own room: Switch's breaker trips on a run of identical refusals,
  // and any answer that is not a refusal resets it.
  async secrecyCheck() {
    const [ownId, any] = [...this.conns.entries()][0];
    for (const [key, room] of Object.entries(this.state.rooms)) {
      if (this.conns.has(room.id)) continue;
      await any.op('read_context', { room_id: ownId, limit: 1 }).catch(() => {});
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await any.op('read_context', { room_id: room.id, limit: 5 });
          this.recorder.write({ kind: 'leak', agent: this.def.name, room: key });
          console.error(`!! ${this.def.displayName} could read ${key}. Secrecy is broken.`);
          break;
        } catch (e) {
          const detail = e.message.replace(/^.*-> /, '');
          const wait = detail.startsWith('429') && Number(detail.match(/for (\d+) s/)?.[1]);
          if (wait) { await new Promise((r) => setTimeout(r, (wait + 1) * 1000)); continue; }
          this.recorder.denied(this.def.name, key, detail);
          break;
        }
      }
    }
  }

  displayOf(sender) {
    if (!sender) return 'someone';
    if (sender === 'table-keeper') return 'Keeper';
    return this.campaign.npcs.find((n) => n.name === sender)?.displayName ?? sender;
  }

  isMe(payload) {
    return payload.sender_name === this.def.displayName || payload.sender_name === this.def.name;
  }

  remember(entry) {
    this.memory.push(entry);
    if (this.memory.length > MAX_MEMORY) this.memory.shift();
  }

  hear(frame) {
    const p = frame.payload || {};
    if (!p.body || isJoinGreeting(p)) return;
    if (p.message_id) { if (this.seen.has(p.message_id)) return; this.seen.add(p.message_id); }
    const room = this.roomLabel(frame.room_id);
    this.recorder.delivery(this.def.name, room, p, frame.sequence);
    this.remember({ id: p.message_id, room, who: this.displayOf(p.sender_name), text: p.body });
    if (process.env.NPC_DEBUG) console.error(`[${this.def.name}] heard in ${room} from ${p.sender_name}; called: ${isCalled(this.def, p)}`);
    if (this.isMe(p) || !isCalled(this.def, p)) return;
    const fromNpc = this.npcNames.includes(p.sender_name);
    const chain = fromNpc ? (this.chain.get(frame.room_id) || 0) + 1 : 0;
    if (fromNpc && chain > MAX_NPC_CHAIN) return;
    this.chain.set(frame.room_id, chain);
    this.pending = { id: p.message_id, roomId: frame.room_id, room, who: this.displayOf(p.sender_name), text: p.body };
    this.drain();
  }

  async drain() {
    if (this.busy || !this.pending) return;
    this.busy = true;
    const turn = this.pending; this.pending = null;
    try {
      const line = await this.reply(turn);
      if (line) {
        await this.conns.get(turn.roomId).post(turn.roomId, line);
        // A stream doesn't echo an agent's own posts, so the NPC remembers its own line here.
        this.remember({ room: turn.room, who: this.def.displayName, text: line });
      }
    } catch (e) {
      console.error(`[${this.def.displayName}] ${e.message}`);
    } finally {
      this.busy = false;
      if (this.pending) this.drain();
    }
  }

  async reply(turn) {
    const { system, prompt } = buildPrompt({ def: this.def, campaign: this.campaign, roomInfo: this.state.rooms[turn.room], memory: this.memory, turn });
    return cleanLine(this.def, await speak(system, prompt));
  }
}
