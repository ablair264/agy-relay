// Queueing: a second run waits for the first instead of exiting 3, can be
// cancelled while queued, and backends do not block each other.
// Run: node --test tests/queue.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../cli/agy-relay');
const FAKE = path.join(here, 'fixtures/fake-codex.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-queue-')));
const HOME = path.join(tmp, 'home');
const procs = [];
after(() => { for (const p of procs) try { p.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(tmp, { recursive: true, force: true }); });
fs.chmodSync(FAKE, 0o755);

const env = (extra = {}) => ({ ...process.env, AGY_RELAY_HOME: HOME, CODEX_BIN: FAKE, AGY_BIN: path.join(tmp, 'no-agy'), AGY_RELAY_EXPLORE: '0', ...extra });
const repo = () => {
  const d = fs.mkdtempSync(path.join(tmp, 'r-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(d, 'greet.test.mjs'), '');
  return fs.realpathSync(d);
};
function start(args, extra) {
  const p = spawn(process.execPath, [CLI, ...args], { env: env(extra) });
  p.out = '';
  p.stdout.on('data', (b) => { p.out += b; });
  p.stderr.on('data', (b) => { p.out += b; });
  p.done = new Promise((r) => p.on('close', (code) => r(code)));
  procs.push(p);
  return p;
}
const ok = (fn) => { try { return fn(); } catch { return false; } };
const until = async (fn, ms = 15e3) => { const t = Date.now(); while (!ok(fn)) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };
const jobs = () => { try { return fs.readdirSync(path.join(HOME, 'jobs')).sort(); } catch { return []; } };
const status = (id) => JSON.parse(fs.readFileSync(path.join(HOME, 'jobs', id, 'status.json'), 'utf8'));
const queuedJob = () => jobs().find((j) => ok(() => status(j).state === 'queued'));
const working = () => jobs().find((j) => ok(() => /^(starting|working)$/.test(status(j).state)));

test('a second run queues behind the first and starts when it ends', async (t) => {
  t.after(() => { for (const p of procs.splice(0)) try { p.kill('SIGKILL'); } catch { /* gone */ } });
  const dir = repo();
  const first = start(['run', '--backend', 'codex', '--dir', dir, '--stall', '600', 'Summarise greet.test.mjs'], { FAKE_CODEX_MODE: 'silent' });
  await until(() => /picked up/.test(first.out));
  const second = start(['run', '--backend', 'codex', '--dir', dir, 'Summarise greet.test.mjs; ask first.']);
  await until(() => /queued: codex is busy with/.test(second.out));
  await until(() => queuedJob());
  const qid = queuedJob();
  assert.equal(status(qid).position, 1);
  assert.equal(spawnSync(process.execPath, [CLI, 'run', '--no-wait', '--backend', 'codex', '--dir', dir, 'x'], { env: env(), encoding: 'utf8' }).status, 3);

  spawnSync(process.execPath, [CLI, 'cancel', working()], { env: env() });
  assert.equal(await first.done, 15);
  assert.equal(await second.done, 10, second.out); // ran: the fake asks a question
  assert.match(second.out, /our turn, starting/);
});

test('cancel removes a queued job; codex does not wait for an agy lock', async (t) => {
  t.after(() => { for (const p of procs.splice(0)) try { p.kill('SIGKILL'); } catch { /* gone */ } });
  const dir = repo();
  const first = start(['run', '--backend', 'codex', '--dir', dir, '--stall', '600', 'Summarise greet.test.mjs'], { FAKE_CODEX_MODE: 'silent' });
  await until(() => /picked up/.test(first.out));
  const second = start(['run', '--backend', 'codex', '--dir', dir, 'Summarise again']);
  await until(() => /queued:/.test(second.out));
  await until(() => queuedJob());
  const qid = queuedJob();
  spawnSync(process.execPath, [CLI, 'cancel', qid], { env: env() });
  assert.equal(await second.done, 15);
  assert.equal(status(qid).state, 'cancelled');
  assert.equal(fs.readdirSync(path.join(HOME, 'queue')).length, 0);
  spawnSync(process.execPath, [CLI, 'cancel', working()], { env: env() });
  await first.done;

  // A live agy lock (held by this test process) must not block codex.
  fs.writeFileSync(path.join(HOME, 'run-agy.lock'), JSON.stringify({ pid: process.pid, id: 'agy-job' }));
  fs.writeFileSync(path.join(HOME, 'run.lock'), JSON.stringify({ pid: process.pid, id: 'legacy-job' }));
  const r = spawnSync(process.execPath, [CLI, 'run', '--no-wait', '--backend', 'codex', '--dir', dir, 'Ask first.'], { env: env(), encoding: 'utf8' });
  assert.equal(r.status, 10, r.stdout + r.stderr);
});

test('the legacy run.lock still blocks agy', async () => {
  const { tryLock } = await import('../lib/queue.mjs');
  // queue.mjs reads AGY_RELAY_HOME at import via store.mjs; use the test HOME.
  assert.ok(process.env.AGY_RELAY_HOME === undefined || true);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'run.lock'), JSON.stringify({ pid: process.ppid, id: 'legacy-job' }));
  const r = spawnSync(process.execPath, ['-e', `process.env.AGY_RELAY_HOME=${JSON.stringify(HOME)}; import(${JSON.stringify(path.join(here, '../lib/queue.mjs'))}).then(q => console.log(JSON.stringify(q.tryLock('agy','x'))))`], { encoding: 'utf8', env: env() });
  assert.match(r.stdout, /legacy-job/, r.stderr);
  void tryLock;
});
