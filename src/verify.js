// One command that checks every claim in the README it can check without a key.
//   npm run verify            no server, no model, no API key
//   npm run verify -- --live  also runs the doctor and the e2e test against your Switch server
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import campaign from '../campaigns/greywater.js';

const live = process.argv.includes('--live');
const root = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
/** @type {{ ok: boolean, what: string, detail: string }[]} */
const results = [];
const check = (what, fn) => {
  try { results.push({ ok: true, what, detail: fn() || '' }); }
  catch (e) { results.push({ ok: false, what, detail: e.message }); }
};
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

check('type check (tsc --checkJs over src, campaigns, eval)', () => {
  const r = run('npx', ['tsc', '-p', 'tsconfig.json']);
  must(r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(0, 5).join(' | '));
  return 'no errors';
});

check('unit tests (protocol client, NPC, Keeper, model adapters, recording)', () => {
  // Spec reporter everywhere: without a TTY (CI) node picks TAP, which prints "# pass" instead.
  const r = run('node', ['--test', '--test-reporter=spec', 'test/unit/*.test.js']);
  const n = (k) => Number((r.stdout.match(new RegExp(`(?:ℹ|#) ${k} (\\d+)`)) || [])[1] ?? NaN);
  const failed = [...new Set(r.stdout.split('\n').filter((l) => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map((l) => l.trim()))];
  must(r.status === 0 && n('fail') === 0, `${n('fail')} failed: ${failed.join(' | ')}`);
  return `${n('pass')} of ${n('tests')} pass`;
});

// The room map in the Switch template must seat each NPC in exactly the rooms the
// campaign says, because that membership is the whole secrecy model.
check('the Switch room template seats each NPC only in its own rooms', () => {
  const yaml = read('templates/greywater.template.yaml');
  const seats = {};
  for (const m of yaml.matchAll(/^ {2}(\w+):\n((?: {4}.*\n?)*)/gm)) {
    const agents = m[2].match(/^ {4}agents: \[(.*)\]/m);
    if (agents) seats[m[1]] = agents[1].split(',').map((s) => s.trim());
  }
  for (const npc of campaign.npcs) {
    const inTemplate = Object.keys(seats).filter((room) => seats[room].includes(npc.name)).sort();
    must(JSON.stringify(inTemplate) === JSON.stringify([...npc.rooms].sort()), `${npc.name}: template ${inTemplate} vs campaign ${npc.rooms}`);
  }
  must(Object.keys(seats).every((room) => seats[room].includes('table-keeper')), 'the Keeper is missing from a room');
  return Object.entries(seats).map(([room, a]) => `${room}: ${a.filter((x) => x !== 'table-keeper').join(', ') || 'no NPC'}`).join('; ');
});

// The live replay page reads viewer/session.json. Audit what it shows.
const session = JSON.parse(read('viewer/session.json'));
check('replay: no NPC was delivered a line from a room it is not in', () => {
  const npcDeliveries = session.deliveries.filter((d) => campaign.npcs.some((n) => n.name === d.agent));
  for (const d of npcDeliveries) {
    const npc = campaign.npcs.find((n) => n.name === d.agent);
    must(npc.rooms.includes(d.room), `${d.agent} got a line from ${d.room}`);
  }
  return `${npcDeliveries.length} NPC deliveries checked`;
});

check('replay: every refusal it recorded is a 403, and nothing leaked', () => {
  must(session.leaks === 0, `${session.leaks} leaks recorded`);
  must(session.denied.length > 0, 'no refusals recorded');
  for (const d of session.denied) {
    must(/^403 /.test(d.detail), `${d.agent} / ${d.room}: ${d.detail}`);
    must(!campaign.npcs.find((n) => n.name === d.agent).rooms.includes(d.room), `${d.agent} was refused its own room ${d.room}`);
  }
  const all = campaign.npcs.reduce((n, npc) => n + Object.keys(campaign.rooms).filter((r) => !npc.rooms.includes(r)).length, 0);
  // The recording ended while Fen was still waiting out Switch's 429 on repeated refusals,
  // so it holds 5 of the 7. The e2e test (--live) asks for all 7 and expects 7 refusals.
  return `${session.denied.length} refusals recorded, all 403 (of ${all} possible; --live checks all ${all})`;
});

check("replay: the alley deal reached Fen and not the duke or the captain", () => {
  const deal = session.deliveries.find((d) => d.room === 'alley' && /lifted the duke's signet/.test(d.body));
  must(deal, 'the alley line is missing');
  const got = new Set(session.deliveries.filter((d) => d.id === deal.id).map((d) => d.agent));
  must(got.has('fen-the-fence') && !got.has('duke-aldric') && !got.has('captain-voss'), [...got].join(', '));
  return `delivered to: ${[...got].join(', ')}`;
});

check('replay page data matches the raw recording it was exported from', () => {
  const lines = read('recordings/greywater-demo.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  const raw = lines.filter((l) => l.kind === 'delivery').map((l) => `${l.agent}|${l.message_id}`);
  const shown = session.deliveries.map((d) => `${d.agent}|${d.id}`);
  must(JSON.stringify(raw) === JSON.stringify(shown), 'viewer/session.json differs from recordings/greywater-demo.jsonl; run npm run export');
  return `${shown.length} deliveries, same order`;
});

check('secrecy eval results match the README table', () => {
  const files = fs.readdirSync(new URL('eval/results/', root)).filter((f) => f.startsWith('secrecy-'));
  const runs = files.map((f) => JSON.parse(read(`eval/results/${f}`)).summary);
  const local = runs.find((s) => /Ollama/.test(s.model) && s.trials === 100);
  must(local, 'no 100-trial local run');
  must(local.dukeMemoryHadAlley === 0 && local.baselinePromptHadAlley === 100, 'alley-in-input counts differ from README');
  must(local.baselineLeaks === 4 && local.tablefolkLeaks === 1, 'flagged-reply counts differ from README');
  const total = runs.reduce((n, s) => n + s.trials, 0), heard = runs.reduce((n, s) => n + s.dukeMemoryHadAlley, 0);
  must(heard === 0, `the Tablefolk duke's input held the alley line in ${heard} trials`);
  return `alley line in the Tablefolk duke's input: 0 of ${total} trials across ${runs.length} runs; 100-trial run flagged baseline ${local.baselineLeaks}, Tablefolk ${local.tablefolkLeaks} (a keyword false positive, see eval/README.md)`;
});

if (live) {
  check('doctor: .env, server, token, chat bridge, model', () => {
    const r = run('node', ['src/doctor.js']);
    must(r.status === 0, r.stdout.split('\n').filter((l) => /^\s+(fail|no)/.test(l)).join(' | ') || 'doctor failed');
    return 'all set';
  });
  check('e2e against a real Switch server', () => {
    const r = run('node', ['test/e2e.js']);
    must(r.status === 0, r.stdout.split('\n').filter((l) => l.startsWith('not ok')).join(' | ') || r.stderr.slice(0, 300));
    return (r.stdout.match(/(\d+) checks passed/) || [])[0] ?? 'passed';
  });
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.what}${r.detail ? `\n      ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks pass${live ? '' : '. Add --live to also run the doctor and the e2e test against your Switch server.'}`);
process.exit(failed ? 1 : 0);
