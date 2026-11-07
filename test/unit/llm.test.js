// The two model adapters against a fake HTTP server: request shape, reply parsing, errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { viaApi, viaOllama } from '../../src/llm.js';

function fake(handler) {
  const reqs = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => { reqs.push({ url: req.url, headers: req.headers, body: JSON.parse(body) }); const [status, json] = handler(); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, reqs, url: `http://127.0.0.1:${server.address().port}` })));
}

test('the Messages API adapter sends system and prompt and joins the text blocks', async (t) => {
  const f = await fake(() => [200, { content: [{ type: 'text', text: ' Begone, ' }, { type: 'text', text: 'thief. ' }] }]);
  t.after(() => f.server.close());
  assert.equal(await viaApi('You are the duke.', 'Mira says hi.', f.url), 'Begone, thief.');
  const r = f.reqs[0];
  assert.equal(r.url, '/v1/messages');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.body.system, 'You are the duke.');
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'Mira says hi.' }]);
});

test('the Messages API adapter turns an error status into an error', async (t) => {
  const f = await fake(() => [429, { type: 'error', error: { type: 'rate_limit_error' } }]);
  t.after(() => f.server.close());
  await assert.rejects(viaApi('s', 'p', f.url), /model 429/);
});

test('the Ollama adapter sends a system message, turns thinking off and trims the reply', async (t) => {
  const f = await fake(() => [200, { message: { role: 'assistant', content: '  *bows* Welcome.  ' } }]);
  t.after(() => f.server.close());
  assert.equal(await viaOllama('You are the duke.', 'Mira says hi.', f.url), '*bows* Welcome.');
  const r = f.reqs[0];
  assert.equal(r.url, '/api/chat');
  assert.equal(r.body.think, false);
  assert.equal(r.body.stream, false);
  assert.deepEqual(r.body.messages.map((m) => m.role), ['system', 'user']);
});

test('the Ollama adapter reports a missing model', async (t) => {
  const f = await fake(() => [404, { error: "model 'x' not found" }]);
  t.after(() => f.server.close());
  await assert.rejects(viaOllama('s', 'p', f.url), /ollama 404/);
});
