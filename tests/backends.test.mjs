// Relay CLI + backend tests. Run: node --test tests/backends.test.mjs
// Uses a fake codex binary and a throwaway AGENT_HANDOFF_HOME; agy is made absent.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../cli/agent-handoff');
const FAKE = path.join(here, 'fixtures/fake-codex.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const HOME = path.join(tmp, 'home');
process.env.AGENT_HANDOFF_HOME = HOME; // before importing lib modules
fs.chmodSync(FAKE, 0o755);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const env = (extra = {}) => ({ ...process.env, AGENT_HANDOFF_HOME: HOME, CODEX_BIN: FAKE, AGY_BIN: path.join(tmp, 'no-agy'), AGENT_HANDOFF_EXPLORE: '0', ...extra });
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
  assert.ok(args1.includes('model_reasoning_effort="low"'), args1.join(' ')); // implement starts on gpt-6.2-sol:low

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

test('auto-benchmarking off: fixed rung, no verdict asked, config round-trips', () => {
  assert.match(cli(['config', 'autobench', 'off']).stdout, /autobench off/);
  const rt = cli(['route', '--backend', 'codex', 'Review the diff in foo.mjs']);
  assert.match(rt.stdout, /auto-benchmarking off: fixed starting rung/);
  assert.match(rt.stdout, /model: gpt-6.2-sol:high/); // review starts on rung 4
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'greet.mjs'), 'export const greet = (n) => n;\n');
  const r = cli(['run', '--backend', 'codex', '--write', '--dir', dir, 'Implement greet; ask first.']);
  assert.equal(r.status, 10);
  const id = fs.readdirSync(path.join(HOME, 'jobs')).sort().pop();
  const r2 = cli(['answer', id, 'English']);
  assert.match(r2.stdout, /auto-benchmarking off: no verdict needed/);
  assert.match(cli(['config', 'autobench', 'on']).stdout, /autobench on/);
  assert.match(cli(['config', 'backend', 'codex']).stdout, /backend\s+codex/);
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

test('routing respects workers, models and usage cut-offs from settings', () => {
  const H = path.join(tmp, 'settings-home');
  const e = { AGENT_HANDOFF_HOME: H };
  // Search starts on rung 1 (luna low); with it off, the next enabled rung is used.
  cli(['config', 'model', 'gpt-6-luna:low', 'off'], e);
  const r1 = cli(['route', '--backend', 'codex', 'Look up the latest release notes'], e);
  assert.match(r1.stdout, /model: gpt-6-luna:medium/, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /turned off in settings: gpt-6-luna:low/);
  // A pinned model that is off is still used, with a note.
  assert.match(cli(['route', '--model', 'gpt-6-luna:low', 'x'], e).stdout, /turned off in settings, used because you pinned it/);
  // Never use a worker below the stop cut-off: codex at 8% left (FAKE_CODEX_USED 92).
  cli(['config', 'limit', 'stop', '10'], e);
  fs.rmSync(path.join(H, 'codex-quota.json'), { force: true }); // drop the cached usage from the calls above
  const r2 = cli(['route', '--backend', 'codex', 'x'], { ...e, FAKE_CODEX_USED: '92,20' });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /codex has 8% usage left, under your 10% cut-off/);
  cli(['config', 'limit', 'stop', '0'], e);
  // A worker switched off is refused, even when named.
  cli(['config', 'worker', 'codex', 'off'], e);
  const r3 = cli(['route', '--backend', 'codex', 'x'], e);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /codex is turned off in settings/);
  assert.match(cli(['route', 'x'], e).stderr, /no worker is available/);
});

test('retry reruns a job on another model and links it to the original', () => {
  const dir = repo();
  const r = cli(['run', '--backend', 'codex', '--dir', dir, 'Summarise greet.test.mjs; ask first.']);
  assert.equal(r.status, 10, r.stdout + r.stderr);
  const first = fs.readdirSync(path.join(HOME, 'jobs')).sort().pop();
  const r2 = cli(['retry', first, '--model', 'gpt-6.2-sol:medium']);
  assert.match(r2.stdout, new RegExp(`rerunning ${first} on gpt-6.2-sol:medium`));
  // The rerun sorts after the original, even in the same minute: the pane follows the newest.
  const second = fs.readdirSync(path.join(HOME, 'jobs')).sort().pop();
  assert.notEqual(second, first);
  const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'jobs', second, 'meta.json'), 'utf8'));
  assert.equal(meta.model, 'gpt-6.2-sol:medium');
  assert.equal(meta.retry_of, first);
  assert.match(fs.readFileSync(path.join(HOME, 'jobs', second, 'task.md'), 'utf8'), /TASK:\nSummarise greet\.test\.mjs; ask first\.$/);
});

test('demo writes sample jobs, refuses real data, and acts on pane requests', async () => {
  const D = path.join(tmp, 'demo');
  const e = { AGENT_HANDOFF_HOME: D };
  const r = cli(['demo', '--once', '--dir', D], e);
  assert.equal(r.status, 0, r.stderr);
  const ids = fs.readdirSync(path.join(D, 'jobs')).sort();
  assert.equal(ids.length, 9);
  assert.ok(ids.every((id) => /^\d{8}-[a-z0-9]{4}$/.test(id)));
  const states = ids.map((id) => JSON.parse(fs.readFileSync(path.join(D, 'jobs', id, 'status.json'), 'utf8')).state);
  assert.deepEqual(states.slice(-3), ['question', 'working', 'starting']);
  // The pane's buttons go through the CLI, which leaves requests for the demo.
  assert.match(cli(['cancel', ids.at(-1)], e).stdout, /cancel sent to the demo/);
  assert.ok(fs.existsSync(path.join(D, 'jobs', ids.at(-1), 'demo-request.json')));
  // A folder with real jobs is refused.
  assert.equal(cli(['demo', '--once', '--dir', HOME], e).status, 2);
  // The scene acts on requests.
  const { Scene } = await import('../lib/demo.mjs');
  const scene = new Scene(path.join(tmp, 'demo2'));
  fs.mkdirSync(scene.home, { recursive: true });
  scene.reset();
  const q = [...scene.jobs.values()].find((j) => j.st.state === 'question');
  fs.writeFileSync(path.join(q.dir, 'demo-request.json'), JSON.stringify({ type: 'answer', text: 'Hide them' }));
  scene.step(Date.now());
  assert.equal(q.st.state, 'starting');
  scene.step(Date.now() + 60e3);
  assert.equal(q.st.state, 'done');
});
