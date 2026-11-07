// The Keeper is a Switch agent with no model. Dice, hit points and side rooms
// are rules, so they live in code where they are always right.
const DICE = /^!roll\s+(\d*)d(\d+)\s*([+-]\s*\d+)?/i;

export function roll(expr, rand = Math.random) {
  const m = expr.match(DICE);
  if (!m) return null;
  const n = Math.min(Number(m[1] || 1), 20), sides = Math.min(Number(m[2]), 1000);
  const mod = m[3] ? Number(m[3].replace(/\s/g, '')) : 0;
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(rand() * sides));
  return { n, sides, mod, rolls, total: rolls.reduce((a, b) => a + b, 0) + mod };
}

export class Keeper {
  constructor({ creds, connect, state, campaign, recorder, roomLabel }) {
    Object.assign(this, { creds, connect, state, campaign, recorder, roomLabel });
    this.conns = new Map();
    this.hp = state.hp || {};
    this.npcs = [];
  }

  async start() {
    for (const room of Object.values(this.state.rooms)) await this.join(room.id);
  }

  async join(roomId) {
    const conn = this.connect(this.creds, `keeper@${this.roomLabel(roomId)}`, [roomId]);
    conn.onEvent((kind, frame) => kind === 'message' && this.hear(frame));
    await conn.start();
    this.conns.set(roomId, conn);
  }

  say(roomId, text) { return this.conns.get(roomId).post(roomId, text); }

  async hear(frame) {
    const p = frame.payload || {};
    if (!p.body) return;
    this.recorder.delivery('table-keeper', this.roomLabel(frame.room_id), p, frame.sequence);
    const body = p.body.trim();
    const who = p.sender_name || 'Someone';
    try {
      if (/^!roll/i.test(body)) {
        const r = roll(body);
        if (!r) return this.say(frame.room_id, 'Try !roll 1d20+3');
        const mod = r.mod ? ` ${r.mod > 0 ? '+' : '-'} ${Math.abs(r.mod)}` : '';
        return this.say(frame.room_id, `🎲 ${who} rolls ${r.n}d${r.sides}${mod}: [${r.rolls.join(', ')}]${mod} = **${r.total}**`);
      }
      if (/^!hp/i.test(body)) return this.say(frame.room_id, this.hpCommand(body));
      if (/^!aside/i.test(body)) return this.aside(frame, body, who);
    } catch (e) {
      console.error(`[keeper] ${e.message}`);
      this.say(frame.room_id, `That didn't work: ${e.message.slice(0, 120)}`).catch(() => {});
    }
  }

  hpCommand(body) {
    const m = body.match(/^!hp\s+(\S+)\s+([+-]?\d+)/i);
    if (m) {
      const [, name, delta] = m;
      const was = this.hp[name] ?? 20;
      this.hp[name] = Math.max(0, was + Number(delta));
      return `❤️ ${name}: ${was} → **${this.hp[name]}**${this.hp[name] === 0 ? ' (down!)' : ''}`;
    }
    const rows = Object.entries(this.hp);
    return rows.length ? '❤️ ' + rows.map(([k, v]) => `${k} ${v}`).join(' · ') : '❤️ Nobody has taken damage yet. Use !hp Mira -4';
  }

  // !aside fen @mira  -> a new private room with the GM, Mira and Fen, opened by Switch on the spot.
  async aside(frame, body, who) {
    const parts = body.split(/\s+/).slice(1);
    const npcWord = (parts.find((w) => !w.startsWith('@')) || '').toLowerCase();
    const npc = this.npcs.find((n) => n.def.call.includes(npcWord) || n.def.name === npcWord);
    if (!npc) return this.say(frame.room_id, `Who should step aside? Try: !aside ${this.campaign.npcs[0].call[0]} @player`);
    const users = parts.filter((w) => w.startsWith('@')).map((w) => w.slice(1));
    const gm = this.state.rooms.table.humans[0];
    const humans = [...new Set([gm, ...users].filter(Boolean))];
    const control = this.conns.get(frame.room_id);
    const made = await control.op('create_room', {
      name: `aside-${npc.def.name}-${Date.now().toString(36).slice(-4)}`,
      description: `A private word with ${npc.def.displayName}.`,
      agent_names: ['table-keeper', npc.def.name], user_names: humans.length ? humans : null, channel_type: 'channel_private',
    });
    const key = made.name;
    this.state.rooms[key] = { id: made.id, name: made.name, title: made.name, about: `A private word with ${npc.def.displayName}, away from the table.`, agents: ['table-keeper', npc.def.name], humans };
    this.recorder.write({ kind: 'room', key, room: this.state.rooms[key] });
    await this.join(made.id);
    await npc.join(made.id);
    await this.say(frame.room_id, `🚪 ${npc.def.displayName} steps aside with ${users.map((u) => '@' + u).join(', ') || who}. Nobody else at the table hears what follows.`);
    await this.say(made.id, `🚪 You step aside with ${npc.def.displayName}. Only the people in this room hear this.`);
  }
}
