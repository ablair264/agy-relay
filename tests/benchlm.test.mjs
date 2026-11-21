// BenchLM prices and scores: the key file, the fetch and cache, and the stats table.
// Uses a local stand-in for data.benchlm.ai with made-up figures (BenchLM's real
// data is CC BY-NC and is never committed here).
// Run: node --test tests/benchlm.test.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../cli/agent-handoff');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-benchlm-')));
const KEY = 'bld_free_testtesttesttesttest';
const seen = [];
let server, base;

const row = (modelKey, name, creator, input, output, overall) => ({ modelKey, name, creator, url: `https://benchlm.ai/models/${modelKey}`, price: { input, output, unit: 'per-1m-tokens' }, overall: { rank: 100 - overall, score: overall } });
const feed = { dataAsOf: '2026-01-02', attribution: 'Data from BenchLM.ai; retain notices', policyUrl: 'https://benchlm.ai/terms#data-access', items: [
  row('gpt-6-2-sol', 'GPT-6.2 Sol', 'OpenAI', 2, 10, 50), row('gpt-6-luna', 'GPT-6 Luna', 'OpenAI', 0.1, 0.5, 30), row('gemini-4-neon', 'Gemini 4 Neon', 'Google', 3, 15, 60),
] };
const ranks = (surface) => ({ surface, items: [{ modelKey: 'gpt-6-2-sol', rank: 4, score: surface === 'coding' ? 51 : 52.5 }, { modelKey: 'gemini-4-neon', rank: 2, score: 61 }] });

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end('{}'); }
    const u = new URL(req.url, 'http://x');
    const body = u.pathname === '/v1/feed/models' ? feed : u.pathname === '/v1/rankings/current' ? ranks(u.searchParams.get('surface')) : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json', 'x-data-monthly-remaining': '997' });
    res.end(JSON.stringify(body || {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// The CLI has to run alongside the stand-in server, so spawn rather than spawnSync.
function cli(args, home, extra = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: tmp, AGENT_HANDOFF_HOME: home, AGENT_HANDOFF_BENCHLM_URL: base, ...extra } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('saving the key writes a private file, fetches once, and prints the table with the credit', async () => {
  const H = path.join(tmp, 'a');
  const r = await cli(['config', 'benchlm-key', KEY], H);
  assert.equal(r.status, 0, r.stderr);
  const f = path.join(H, 'benchlm-key');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.doesNotMatch(r.stdout, new RegExp(KEY), 'the key is never printed');
  assert.match(r.stdout, /^codex\s+Sol 6\.2\s+\$2\/\$10\s+51 #4\s+53 #4\s+50 #50\s+low medium high$/m);
  assert.match(r.stdout, /^agy\s+Neon \(Gemini 4\)\s+\$3\/\$15\s+61 #2/m);
  assert.match(r.stdout, /Data from BenchLM\.ai \(https:\/\/benchlm\.ai\), as of 2026-01-02 · 997 reads left/);
  assert.deepEqual(seen.slice(-3).map((s) => s.url.split('?')[0]), ['/v1/feed/models', '/v1/rankings/current', '/v1/rankings/current']);
  // Cached for a week: showing the table again makes no request.
  const n = seen.length;
  assert.match((await cli(['stats'], H)).stdout, /Sol 6\.2/);
  assert.match((await cli(['stats', '--if-stale'], H)).stdout, /^$/);
  assert.equal(seen.length, n);
  // config shows where the key is, not the key.
  const c = (await cli(['config'], H)).stdout;
  assert.match(c, /benchlm\s+key set \(key file\); data as of 2026-01-02/);
  assert.doesNotMatch(c, new RegExp(KEY));
});

test('without a key: stats explains how to get one, and the quiet refresh does nothing', async () => {
  const H = path.join(tmp, 'b');
  const r = await cli(['stats'], H);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no BenchLM key: create a free one at https:\/\/benchlm\.ai\/data\/access/);
  assert.equal((await cli(['stats', '--if-stale'], H)).status, 0);
});

test('a refused key is reported, and garbage is not saved as a key', async () => {
  const H = path.join(tmp, 'c');
  const r = await cli(['stats', '--refresh'], H, { AGENT_HANDOFF_BENCHLM_KEY: 'bld_free_wrongwrongwrongwrong' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /BenchLM refused the key \(HTTP 401\)/);
  assert.equal((await cli(['config', 'benchlm-key', 'nope'], H)).status, 2);
  assert.ok(!fs.existsSync(path.join(H, 'benchlm-key')));
});
