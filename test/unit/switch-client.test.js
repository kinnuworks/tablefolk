// The protocol client against a small fake Switch bridge: SSE down, HTTP up.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SwitchAgent } from '../../src/switch-client.js';

function fakeBridge() {
  const seen = { opens: [], beats: 0, ops: [], posts: [] };
  let stream = null, opFailures = 0, beatStatus = 200;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    assert.equal(req.headers.authorization, 'Bearer key-1');
    if (url.pathname.endsWith('/events')) {
      seen.opens.push({ q: Object.fromEntries(url.searchParams), lastEventId: req.headers['last-event-id'] ?? null });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: connection_state\ndata: ${JSON.stringify({ rooms: url.searchParams.get('rooms')?.split(',') ?? [], cursor: 7 })}\n\n`);
      stream = res;
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (url.pathname.endsWith('/connection/beat')) { seen.beats++; res.writeHead(beatStatus); return res.end('{}'); }
      if (url.pathname.includes('/ops/')) {
        seen.ops.push({ name: url.pathname.split('/').pop(), args: JSON.parse(body), conn: req.headers['x-switch-connection-id'] });
        if (opFailures > 0) { opFailures--; res.writeHead(409); return res.end('{"detail":"connection x is not open; reconnect and resume"}'); }
        res.writeHead(200); return res.end(JSON.stringify({ result: { ok: true } }));
      }
      if (url.pathname.endsWith('/message')) { seen.posts.push(JSON.parse(body)); res.writeHead(200); return res.end('{}'); }
      res.writeHead(404); res.end();
    });
  });
  return {
    seen, server,
    send: (seq, payload, room = 'R1') => stream.write(`id: ${seq}\nevent: message\ndata: ${JSON.stringify({ type: 'message', room_id: room, payload, sequence: seq })}\n\n`),
    sendSplit: (text) => { stream.write(text.slice(0, 10)); setTimeout(() => stream.write(text.slice(10)), 5); },
    drop: () => stream.destroy(),
    failOps: (n) => (opFailures = n),
    beatWith: (s) => (beatStatus = s),
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await wait(20); } throw new Error('timed out'); }

test('opens the stream with the rooms declared on the URL and reads connection_state', async (t) => {
  const b = fakeBridge(); const url = await b.listen(); t.after(() => b.server.close());
  const a = new SwitchAgent({ baseUrl: url, agentId: 'A', apiKey: 'key-1', name: 'duke', rooms: ['R1'] });
  const state = await a.start(); t.after(() => a.stop());
  assert.deepEqual(state.rooms, ['R1']);
  assert.equal(b.seen.opens[0].q.scope, 'single');
  assert.equal(b.seen.opens[0].q.rooms, 'R1');
  assert.equal(b.seen.opens[0].q.start_from, 'head');
});

test('delivers message frames, including ones split across chunks', async (t) => {
  const b = fakeBridge(); const url = await b.listen(); t.after(() => b.server.close());
  const a = new SwitchAgent({ baseUrl: url, agentId: 'A', apiKey: 'key-1', name: 'duke', rooms: ['R1'] });
  const got = [];
  a.onEvent((kind, f) => got.push([kind, f.payload.body]));
  await a.start(); t.after(() => a.stop());
  b.send(8, { body: 'hello' });
  b.sendSplit(`id: 9\nevent: message\ndata: ${JSON.stringify({ room_id: 'R1', payload: { body: 'split' }, sequence: 9 })}\n\n`);
  await until(() => got.length === 2);
  assert.deepEqual(got, [['message', 'hello'], ['message', 'split']]);
  assert.equal(a.cursor, 9);
});

test('after a dropped socket it reopens the same connection with Last-Event-ID', async (t) => {
  const b = fakeBridge(); const url = await b.listen(); t.after(() => b.server.close());
  const a = new SwitchAgent({ baseUrl: url, agentId: 'A', apiKey: 'key-1', name: 'duke', rooms: ['R1'] });
  await a.start(); t.after(() => a.stop());
  b.send(12, { body: 'before the drop' });
  await until(() => a.cursor === 12);
  b.drop();
  await until(() => b.seen.opens.length === 2);
  assert.equal(b.seen.opens[1].q.connection_id, b.seen.opens[0].q.connection_id);
  assert.equal(b.seen.opens[1].lastEventId, '12');
  assert.equal(b.seen.opens[1].q.start_from, undefined);
});

test('beats every 2 seconds, and a 404 beat makes it reopen the stream', async (t) => {
  const b = fakeBridge(); const url = await b.listen(); t.after(() => b.server.close());
  const a = new SwitchAgent({ baseUrl: url, agentId: 'A', apiKey: 'key-1', name: 'duke', rooms: ['R1'] });
  await a.start(); t.after(() => a.stop());
  await until(() => b.seen.beats >= 1, 3000);
  b.beatWith(404);
  await until(() => b.seen.opens.length >= 2, 5000);
});

test('operations carry the connection id and are resent after a 409 reconnect', async (t) => {
  const b = fakeBridge(); const url = await b.listen(); t.after(() => b.server.close());
  const a = new SwitchAgent({ baseUrl: url, agentId: 'A', apiKey: 'key-1', name: 'duke', rooms: ['R1'] });
  await a.start(); t.after(() => a.stop());
  b.failOps(2);
  const result = await a.op('read_context', { room_id: 'R1', limit: 1 });
  assert.deepEqual(result, { ok: true });
  assert.equal(b.seen.ops.length, 3);
  assert.ok(b.seen.ops.every((o) => o.conn === a.connectionId));
  await a.post('R1', 'Begone.');
  assert.deepEqual(b.seen.posts, [{ room_id: 'R1', content: 'Begone.' }]);
});
