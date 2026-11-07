// Writes what each agent actually received, one JSON line per delivery.
// The viewer replays these lines to show the table through any one agent's eyes.
import fs from 'node:fs';
export class Recorder {
  constructor(campaign, state) {
    fs.mkdirSync(new URL('../sessions/', import.meta.url), { recursive: true });
    this.file = new URL(`../sessions/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`, import.meta.url).pathname;
    this.write({ kind: 'header', campaign: campaign.title, setting: campaign.setting,
      npcs: campaign.npcs.map(({ name, displayName, rooms }) => ({ name, displayName, rooms })),
      rooms: Object.fromEntries(Object.entries(state.rooms).map(([k, r]) => [k, { title: r.title, about: r.about, agents: r.agents, humans: r.humans }])) });
  }
  write(obj) { fs.appendFileSync(this.file, JSON.stringify({ t: Date.now(), ...obj }) + '\n'); }
  delivery(agent, room, payload, seq) {
    this.write({ kind: 'delivery', agent, room, seq, sender: payload.sender_name || payload.sender, body: payload.body, message_id: payload.message_id });
  }
  denied(agent, room, detail) { this.write({ kind: 'denied', agent, room, detail }); }
  close() {}
}
