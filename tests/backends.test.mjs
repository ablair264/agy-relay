// Relay CLI + backend tests. Run: node --test tests/backends.test.mjs
// Uses a fake codex binary and a throwaway AGY_RELAY_HOME; agy is made absent.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../cli/agy-relay');
const FAKE = path.join(here, 'fixtures/fake-codex.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const HOME = path.join(tmp, 'home');
process.env.AGY_RELAY_HOME = HOME; // before importing lib modules
fs.chmodSync(FAKE, 0o755);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const env = (extra = {}) => ({ ...process.env, AGY_RELAY_HOME: HOME, CODEX_BIN: FAKE, AGY_BIN: path.join(tmp, 'no-agy'), AGY_RELAY_EXPLORE: '0', ...extra });
const cli = (args, extra) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env(extra), timeout: 60e3 });

function repo() {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const g = (...a) => spawnSync('git', a, { cwd: dir });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'greet.test.mjs'), "import { greet } from './greet.mjs';\nif (!greet('A').includes('A')) process.exit(1);\n");
  g('add', '.'); g('commit', '-qm', 'init');
  return fs.realpathSync(dir);
}

test('codex: question, answer by resume, file change, gate and ledger', () => {
  const dir = repo();
  const r1 = cli(['run', '--backend', 'codex', '--write', '--dir', dir, '--tests', 'node greet.test.mjs', 'Add greet.mjs exporting greet(name); ask which language first.']);
  assert.equal(r1.status, 10, r1.stdout + r1.stderr); // question
  assert.match(r1.stdout, /backend: codex/);
  assert.match(r1.stdout, /QUESTION: Which language/);
  const args1 = JSON.parse(fs.readFileSync(path.join(HOME, 'fake-codex-args.json'), 'utf8'));
  assert.deepEqual(args1.slice(0, 3), ['exec', '-C', dir]);
  assert.ok(args1.includes('--json') && args1.includes('--output-schema'));
  assert.ok(args1.includes('sandbox_mode="workspace-write"'));
  assert.ok(args1.includes('model_reasoning_effort="low"'), args1.join(' ')); // implement starts on gpt-6.1-sol:low

  const id = fs.readdirSync(path.join(HOME, 'jobs')).sort().pop();
  const r2 = cli(['answer', id, 'Spanish']);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const args2 = JSON.parse(fs.readFileSync(path.join(HOME, 'fake-codex-args.json'), 'utf8'));
  assert.deepEqual(args2.slice(0, 3), ['exec', 'resume', 'thread-fake-1']);
  assert.match(r2.stdout, /changed \(git\): \?\? greet\.mjs/);
  assert.match(r2.stdout, /gate: PASS/);
  assert.match(r2.stdout, /verify .* pass\|partial\|fail/);

  const rows = fs.readFileSync(path.join(HOME, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = rows.at(-1);
  assert.equal(last.backend, 'codex');
  assert.equal(last.state, 'done');
  assert.equal(last.tests_pass, true);
  assert.equal(last.tokens.total, 3000); // 1500 per turn, two turns
  const events = fs.readFileSync(path.join(HOME, 'jobs', id, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"tool","state":"done".*"tool":"shell","arg":"ls"/);
});

test('codex: usage limit ends the job as limited and the router skips codex', () => {
  const dir = repo();
  const r = cli(['run', '--backend', 'codex', '--dir', dir, 'Summarise greet.test.mjs'], { FAKE_CODEX_MODE: 'limit' });
  assert.equal(r.status, 16, r.stdout + r.stderr);
  assert.match(r.stdout, /usage limit/);
  const lim = JSON.parse(fs.readFileSync(path.join(HOME, 'codex-limit.json'), 'utf8'));
  assert.equal(new Date(lim.until).getFullYear(), 2099);
  const q = cli(['quota']);
  assert.match(q.stdout, /codex limited until/);
  // auto routing: codex is the only installed backend, so it warns and tries anyway
  const rt = cli(['route', 'Summarise greet.test.mjs']);
  assert.match(rt.stdout, /skipping codex: Codex usage limit/);
  fs.rmSync(path.join(HOME, 'codex-limit.json'));
});

test('bench off: fixed rung, no verdict asked, config round-trips', () => {
  assert.match(cli(['config', 'bench', 'off']).stdout, /bench\s+off/);
  const rt = cli(['route', '--backend', 'codex', 'Review the diff in foo.mjs']);
  assert.match(rt.stdout, /bench off: fixed starting rung/);
  assert.match(rt.stdout, /model: gpt-6.1-sol:high/); // review starts on rung 4
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'greet.mjs'), 'export const greet = (n) => n;\n');
  const r = cli(['run', '--backend', 'codex', '--write', '--dir', dir, 'Implement greet; ask first.']);
  assert.equal(r.status, 10);
  const id = fs.readdirSync(path.join(HOME, 'jobs')).sort().pop();
  const r2 = cli(['answer', id, 'English']);
  assert.match(r2.stdout, /bench off: no verdict needed/);
  assert.match(cli(['config', 'bench', 'on']).stdout, /bench\s+on/);
  assert.match(cli(['config', 'backend', 'codex']).stdout, /backend codex/);
  assert.equal(cli(['config', 'backend', 'gemini']).status, 2);
});

test('stall watchdog kills a silent codex turn', () => {
  const dir = repo();
  const r = cli(['run', '--backend', 'codex', '--dir', dir, '--stall', '6', 'Summarise greet.test.mjs'], { FAKE_CODEX_MODE: 'silent' });
  assert.equal(r.status, 12, r.stdout + r.stderr);
  assert.match(r.stdout, /KILL: stalled/);
});

test('parsers: agy stream-json and codex limit time', async () => {
  const agy = await import('../lib/backends/agy.mjs');
  const codex = await import('../lib/backends/codex.mjs');
  const p = agy.parser({ dir: '/w' });
  assert.deepEqual(p({ event: 'init', conversation_id: 'c1' }), [{ k: 'pickup', id: 'c1' }]);
  const t = p({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: '/w/a.js' } } } });
  const end = t.find((e) => e.k === 'tool_end');
  assert.equal(end.arg, 'a.js');
  assert.deepEqual(end.files, ['/w/a.js']);
  const res = p({ event: 'result', result: { status: 'SUCCESS', response: '{"status":"done","summary":"x"}', usage: { total_tokens: 9 } } });
  assert.equal(res[0].ok, true);
  assert.equal(res[0].usage.total, 9);
  assert.equal(new Date(codex.limitUntil('… or try again at Nov 13th, 2026 8:32 PM.')).getDate(), 13);
  assert.equal(codex.backendOf, undefined);
  const { backendOf } = await import('../lib/backends/index.mjs');
  assert.equal(backendOf('gpt-6.1-sol:high'), 'codex');
  assert.equal(backendOf('gemini-4-hydrogen-low'), 'agy');
});
