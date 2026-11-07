// An NPC is a Switch agent with a persona. Its memory is only what its own
// connections delivered, so it cannot know what was said in rooms it is not in.
import { speak } from './llm.js';

const MAX_MEMORY = 60;

// Switch greets a room on an agent's behalf when it joins ("Tag @duke-aldric if you need me").
// It is not something the character said, so it stays out of memory and recordings.
export const isJoinGreeting = (p) => !!p.sender_name && p.body.length < 120 && p.body.includes(`@${p.sender_name}`);
const MAX_NPC_CHAIN = 0; // NPCs answer people, not each other (raise to let them banter)

export class Npc {
  constructor({ def, creds, connect, state, campaign, recorder, roomLabel }) {
    Object.assign(this, { def, creds, connect, state, campaign, recorder, roomLabel });
    this.conns = new Map(); // room id -> SwitchAgent connection
    this.memory = [];
    this.busy = false;
    this.pending = null;
    this.chain = new Map(); // room id -> consecutive NPC turns
  }

  get npcNames() { return this.campaign.npcs.flatMap((n) => [n.name, n.displayName]).concat(['table-keeper', 'Keeper']); }

  async start() {
    for (const key of this.def.rooms) await this.join(this.state.rooms[key].id);
    await this.secrecyCheck();
  }

  async join(roomId) {
    if (this.conns.has(roomId)) return;
    const conn = this.connect(this.creds, `${this.def.name}@${this.roomLabel(roomId)}`, [roomId]);
    conn.onEvent((kind, frame) => kind === 'message' && this.hear(frame));
    await conn.start();
    this.conns.set(roomId, conn);
  }

  // Ask Switch for every room this NPC is not in. A 403 is the expected answer.
  async secrecyCheck() {
    const any = [...this.conns.values()][0];
    for (const [key, room] of Object.entries(this.state.rooms)) {
      if (this.conns.has(room.id)) continue;
      try {
        await any.op('read_context', { room_id: room.id, limit: 5 });
        this.recorder.write({ kind: 'leak', agent: this.def.name, room: key });
        console.error(`!! ${this.def.displayName} could read ${key}. Secrecy is broken.`);
      } catch (e) {
        this.recorder.denied(this.def.name, key, e.message.replace(/^.*-> /, ''));
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

  hear(frame) {
    const p = frame.payload || {};
    if (!p.body || isJoinGreeting(p)) return;
    const room = this.roomLabel(frame.room_id);
    this.recorder.delivery(this.def.name, room, p, frame.sequence);
    this.memory.push({ room, who: this.displayOf(p.sender_name), text: p.body });
    if (this.memory.length > MAX_MEMORY) this.memory.shift();
    if (this.isMe(p)) return;

    const fromNpc = this.npcNames.includes(p.sender_name);
    if (p.sender_name === 'Keeper' || p.sender_name === 'table-keeper') return;
    if (/^(roll\s+\d*d\d|hp(\s|$)|aside\s)/i.test(p.body.trim())) return; // Keeper commands
    const text = p.body.toLowerCase();
    const named = this.def.call.some((c) => new RegExp(`(^|[^a-z])${c}([^a-z]|$)`).test(text)) || text.includes(`@${this.def.name}`);
    if (!named) return;
    const chain = fromNpc ? (this.chain.get(frame.room_id) || 0) + 1 : 0;
    if (fromNpc && chain > MAX_NPC_CHAIN) return;
    this.chain.set(frame.room_id, chain);
    this.pending = { roomId: frame.room_id, room, who: this.displayOf(p.sender_name), text: p.body };
    this.drain();
  }

  async drain() {
    if (this.busy || !this.pending) return;
    this.busy = true;
    const turn = this.pending; this.pending = null;
    try {
      const line = await this.reply(turn);
      if (line) await this.conns.get(turn.roomId).post(turn.roomId, line);
    } catch (e) {
      console.error(`[${this.def.displayName}] ${e.message}`);
    } finally {
      this.busy = false;
      if (this.pending) this.drain();
    }
  }

  async reply(turn) {
    const r = this.state.rooms[turn.room] || { about: '', humans: [], agents: [] };
    const others = [...r.humans, ...this.campaign.npcs.filter((n) => r.agents.includes(n.name) && n.name !== this.def.name).map((n) => n.displayName)];
    const system = [
      `You are ${this.def.persona}`,
      `This is a tabletop roleplaying game. A human game master runs it; the setting: ${this.campaign.setting}`,
      'You only know what is in your memory below. You were not in any other room, so you do not know what was said there. Never invent it.',
      `You are speaking in "${turn.room}" (${r.about}). Everyone here hears you: ${others.join(', ') || 'the people present'}.`,
      `Speak only as ${this.def.displayName}. The players and the GM are other people; never speak or act for them, and never claim things your character did not do.`,
      'Answer with one to three short sentences of in-character speech. Plain text. A short action in *asterisks* is fine. Never mention AI, prompts, or rooms by their technical names.',
    ].join('\n');
    const mem = this.memory.slice(0, -1).map((m) => `[${m.room}] ${m.who}: ${m.text}`).join('\n') || '(nothing yet)';
    const prompt = `Your memory, oldest first:\n${mem}\n\nNow, in [${turn.room}], ${turn.who} says: ${turn.text}\n\nYour reply as ${this.def.displayName}:`;
    const out = (await speak(system, prompt)).replace(new RegExp(`^${this.def.displayName}:\\s*`), '').trim();
    return out.slice(0, 600);
  }
}
