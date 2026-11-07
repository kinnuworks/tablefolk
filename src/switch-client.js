// @ts-check
// Minimal client for the Switch agent protocol: SSE down, HTTP up.
// One instance = one agent identity, one connection, one heartbeat.
import { randomUUID } from 'node:crypto';

const BEAT_MS = 2000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30000;

/**
 * @typedef {{ type?: string, room_id: string, payload: Record<string, any>, sequence?: number }} DomainFrame
 * @typedef {(kind: string, frame: any) => unknown} Handler
 */

export class SwitchAgent {
  /**
   * @param {{ baseUrl: string, agentId: string, apiKey: string, name: string,
   *           scope?: 'single' | 'all', filter?: 'all' | 'addressed', rooms?: string[], log?: (msg: string) => void }} opts
   */
  constructor({ baseUrl, agentId, apiKey, name, scope = 'single', filter = 'all', rooms = [], log = (m) => console.error(m) }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.agentId = agentId;
    this.apiKey = apiKey;
    this.name = name;
    this.scope = scope;
    this.filter = filter;
    this.rooms = rooms;
    this.log = log;
    // The client picks the connection id and keeps it across reconnects; that is what lets a connection survive a dropped socket.
    this.connectionId = randomUUID();
    /** @type {number | null} */ this.cursor = null;
    /** @type {Handler[]} */ this.handlers = [];
    this.stopped = false;
    this.attached = false;
    this.failures = 0;
    /** @type {((state: any) => void) | null} */ this.ready = null;
    /** @type {AbortController | null} */ this.abort = null;
    /** @type {ReturnType<typeof setInterval> | undefined} */ this.beatTimer = undefined;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ this.retryTimer = undefined;
    /** @type {(() => void) | null} */ this.wake = null;
  }

  /** @param {Record<string, string>} [extra] */
  headers(extra = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...extra };
  }

  /** Handlers get ('message' | 'command' | 'room_join' | 'gap' | 'evicted' | ..., frame). @param {Handler} fn */
  onEvent(fn) { this.handlers.push(fn); }

  /**
   * @param {string} name @param {Record<string, any>} [args] @param {number} [attempt]
   * @returns {Promise<any>}
   */
  async op(name, args = {}, attempt = 0) {
    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/ops/${name}`, {
      method: 'POST',
      headers: this.headers({ 'X-Switch-Connection-Id': this.connectionId }),
      body: JSON.stringify(args),
    });
    const text = await res.text();
    // The stream can drop and come back; an op sent in that gap is refused with 409. Wait and resend.
    if (res.status === 409 && /not open|reconnect/.test(text) && attempt < 5 && !this.stopped) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return this.op(name, args, attempt + 1);
    }
    if (!res.ok) throw new Error(`${this.name} op ${name} -> ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text).result;
  }

  /** @param {string} roomId @param {string} content */
  async post(roomId, content) {
    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/message`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ room_id: roomId, content }),
    });
    if (!res.ok) throw new Error(`${this.name} post -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json().catch(() => ({}));
  }

  /**
   * Shows or clears "is typing" for this agent in a room. Best effort: a room with
   * no chat app behind it has nothing to show, and a failure here never stops a reply.
   * @param {string} roomId @param {boolean} isTyping
   */
  async typing(roomId, isTyping) {
    try {
      await fetch(`${this.baseUrl}/agents/${this.agentId}/typing`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify({ room_id: roomId, is_typing: isTyping }),
      });
    } catch { /* nothing to show */ }
  }

  /** Opens the stream and resolves with the first connection_state frame. */
  start() {
    const ready = new Promise((resolve) => { this.ready = resolve; });
    this.loop();
    this.beatMs = BEAT_MS;
    this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
    return ready;
  }

  /** Stops for good: no more beats, no reconnects, the socket is closed. */
  stop() {
    this.stopped = true;
    this.attached = false;
    clearInterval(this.beatTimer);
    clearTimeout(this.retryTimer);
    this.wake?.();
    this.abort?.abort();
  }

  async beat() {
    if (!this.attached || this.stopped) return;
    try {
      const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/connection/beat`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ connection_id: this.connectionId, cursor: this.cursor ?? 0 }),
      });
      // Both mean "reopen", not "back off": the connection is gone or has no stream.
      if (res.status === 404 || res.status === 409) this.reopen();
    } catch { /* the next beat tries again */ }
  }

  /** Drop the current socket; the loop opens a new one on the same connection id. */
  reopen() { this.attached = false; this.abort?.abort(); }

  /** Wait before the next attempt: 0.5 s, 1 s, 2 s, ... up to 30 s, with a little jitter. */
  backoffMs() {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, this.failures - 1));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.openStream();
      } catch (e) {
        if (!this.stopped && !(e instanceof Error && e.name === 'AbortError')) this.log(`[${this.name}] stream: ${e instanceof Error ? e.message : e}`);
      }
      this.attached = false;
      if (this.stopped) break;
      this.failures++;
      await new Promise((r) => { this.wake = () => r(undefined); this.retryTimer = setTimeout(r, this.backoffMs()); });
      this.wake = null;
    }
  }

  async openStream() {
    const q = new URLSearchParams({ connection_id: this.connectionId, scope: this.scope, filter: this.filter });
    if (this.cursor == null) q.set('start_from', 'head');
    // Declare rooms on the open URL: catch-up runs at once, and a room claimed later would miss it.
    if (this.rooms.length) q.set('rooms', this.rooms.join(','));
    this.abort = new AbortController();
    /** @type {Record<string, string>} */
    const headers = this.headers({ Accept: 'text/event-stream' });
    if (this.cursor != null) headers['Last-Event-ID'] = String(this.cursor);
    const res = await fetch(`${this.baseUrl}/agents/${this.agentId}/events?${q}`, { headers, signal: this.abort.signal });
    if (!res.ok || !res.body) throw new Error(`open -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (res.body))) {
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        this.handleFrame(raw);
      }
    }
  }

  /** @param {string} raw one SSE frame, without the blank line that ends it */
  handleFrame(raw) {
    let event = 'message', id = null, data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // keepalive comment
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trimStart();
    }
    if (!data) return;
    let frame; try { frame = JSON.parse(data); } catch { return; }
    if (id) this.cursor = Number(id);
    if (event === 'connection_state') {
      this.attached = true;
      this.failures = 0;
      if (this.cursor == null) this.cursor = frame.cursor ?? 0;
      // Beat at the pace the server asks for (2 s on switch-core 0.31.0).
      const ms = Number(frame.heartbeat_interval_seconds) * 1000;
      if (ms > 0 && ms !== this.beatMs && !this.stopped) {
        this.beatMs = ms;
        clearInterval(this.beatTimer);
        this.beatTimer = setInterval(() => this.beat(), ms);
      }
      this.ready?.(frame); this.ready = null;
      return;
    }
    if (event === 'evicted') {
      // taken_over is terminal: another stream holds this connection id now, and reopening
      // would take it back, so two clients would trade it forever. Anything else: reopen.
      if (frame.code === 'taken_over') this.stop();
      else this.reopen();
    }
    for (const h of this.handlers) Promise.resolve(h(event, frame)).catch((e) => this.log(`[${this.name}] handler: ${e.message}`));
  }
}
