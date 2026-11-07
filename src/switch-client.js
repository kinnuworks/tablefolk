// Minimal client for the Switch agent protocol: SSE down, HTTP up.
// One instance = one agent identity, one connection, one heartbeat.
import { randomUUID } from 'node:crypto';

export class SwitchAgent {
  constructor({ baseUrl, agentId, apiKey, name, scope = 'all', filter = 'all', rooms = [] }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), agentId, apiKey, name, scope, filter, rooms });
    this.connectionId = randomUUID();
    this.cursor = null;
    this.handlers = [];
    this.stopped = false;
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...extra };
  }

  onEvent(fn) { this.handlers.push(fn); }

  async op(name, args = {}, attempt = 0) {
    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/ops/${name}`, {
      method: 'POST',
      headers: this.headers({ 'X-Switch-Connection-Id': this.connectionId }),
      body: JSON.stringify(args),
    });
    const text = await res.text();
    // The stream can drop and come back; an op sent in that gap is refused with 409. Wait and resend.
    if (res.status === 409 && /not open|reconnect/.test(text) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return this.op(name, args, attempt + 1);
    }
    if (!res.ok) throw new Error(`${this.name} op ${name} -> ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text).result;
  }

  async post(roomId, content) {
    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/message`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ room_id: roomId, content }),
    });
    if (!res.ok) throw new Error(`${this.name} post -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json().catch(() => ({}));
  }

  async start() {
    this.loop();
    this.beatTimer = setInterval(() => this.beat(), 2000);
    return new Promise((resolve) => { this.ready = resolve; });
  }

  stop() { this.stopped = true; clearInterval(this.beatTimer); this.abort?.abort(); }

  async beat() {
    if (!this.attached) return;
    try {
      const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/connection/beat`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ connection_id: this.connectionId, cursor: this.cursor ?? 0 }),
      });
      if (res.status === 404 || res.status === 409) { this.attached = false; this.abort?.abort(); }
    } catch { /* next beat retries */ }
  }

  async loop() {
    while (!this.stopped) {
      try { await this.openStream(); } catch (e) { if (!this.stopped) console.error(`[${this.name}] stream: ${e.message}`); }
      this.attached = false;
      if (!this.stopped) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async openStream() {
    const q = new URLSearchParams({ connection_id: this.connectionId, scope: this.scope, filter: this.filter });
    if (this.cursor == null) q.set('start_from', 'head');
    if (this.rooms.length) q.set('rooms', this.rooms.join(','));
    this.abort = new AbortController();
    const headers = this.headers({ Accept: 'text/event-stream' });
    if (this.cursor != null) headers['Last-Event-ID'] = String(this.cursor);
    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/events?${q}`, { headers, signal: this.abort.signal });
    if (!res.ok) throw new Error(`open -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        this.handleFrame(raw);
      }
    }
  }

  handleFrame(raw) {
    let event = 'message', id = null, data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trimStart();
    }
    if (!data) return;
    let frame; try { frame = JSON.parse(data); } catch { return; }
    if (id) this.cursor = Number(id);
    if (event === 'connection_state') {
      this.attached = true;
      if (this.cursor == null) this.cursor = frame.cursor ?? 0;
      this.ready?.(frame); this.ready = null;
      return;
    }
    if (event === 'evicted') { this.attached = false; return; }
    for (const h of this.handlers) Promise.resolve(h(event, frame)).catch((e) => console.error(`[${this.name}] handler: ${e.message}`));
  }
}
