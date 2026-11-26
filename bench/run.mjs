#!/usr/bin/env node
// Benchmark runner: hand each task to each model through the real relay (`agent-handoff run`),
// then score it ourselves with a visible test (what the worker saw) and a hidden one (what it
// did not). Runs go to their own data folder so they never distort live routing.
//   node bench/run.mjs --selftest                      check every task is solvable and starts failing
//   node bench/run.mjs --models a,b --set easy|hard|all --reps 2   (or --tasks id,id)
//   node bench/run.mjs --report [--models ...]         table from saved results
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS as EASY, solve } from './tasks.mjs';
import { HARD } from './tasks-hard.mjs';

const TASKS = [...EASY, ...HARD];
const SETS = { easy: EASY, hard: HARD, all: TASKS };
import { backendOf } from '../lib/backends/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'agent-handoff');
export const BENCH_HOME = process.env.BENCH_HOME || path.join(os.homedir(), '.agent-handoff-bench');
const RESULTS = path.join(BENCH_HOME, 'bench-results.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function materialize(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  const g = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.email=b@b', '-c', 'user.name=bench', ...a], { encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'start');
  return dir;
}
const nodeTest = (dir, files) => spawnSync(process.execPath, ['--test', ...files], { cwd: dir, encoding: 'utf8', timeout: 60e3 }).status === 0;
const visibleOf = (task) => Object.keys(task.files).filter((f) => f.startsWith('test/'));

// Score a finished workspace. Hidden test is copied in only now.
function score(task, dir) {
  const orig = Object.fromEntries(visibleOf(task).map((f) => [f, task.files[f]]));
  const tampered = Object.entries(orig).some(([f, c]) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') !== c; } catch { return true; } });
  const visible = nodeTest(dir, visibleOf(task));
  fs.writeFileSync(path.join(dir, 'test', 'zz-hidden.test.js'), task.hidden);
  const hidden = nodeTest(dir, ['test/zz-hidden.test.js']);
  return { visible, hidden, tampered, pass: visible && hidden && !tampered };
}

function selftest() {
  let bad = 0;
  for (const t of TASKS) {
    const start = materialize(t.files);
    const before = score(t, start);
    const done = materialize({ ...t.files, ...solve(t) });
    const after = score(t, done);
    const ok = !before.visible && after.pass;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${t.id.padEnd(22)} start: visible ${before.visible ? 'passes (bad)' : 'fails'}  solved: visible ${after.visible} hidden ${after.hidden}`);
    fs.rmSync(start, { recursive: true, force: true }); fs.rmSync(done, { recursive: true, force: true });
  }
  return bad ? 1 : 0;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

async function one(task, model, rep, timeout) {
  const dir = materialize(task.files);
  const t0 = Date.now();
  const env = { ...process.env, AGENT_HANDOFF_HOME: BENCH_HOME, AGENT_HANDOFF_EXPLORE: '0', AGENT_HANDOFF_AUTOBENCH: 'off' };
  const r = await runCli(['run', '--backend', backendOf(model), '--model', model, '--dir', dir, '--write', '--kind', 'implement', '--timeout', timeout, task.task], env);
  const secs = Math.round((Date.now() - t0) / 1000);
  const m = r.out.match(/=== agent-handoff (\S+) · (\S+) ·/);
  const id = m?.[1] || null;
  let st = {};
  if (id) { try { st = JSON.parse(fs.readFileSync(path.join(BENCH_HOME, 'jobs', id, 'status.json'), 'utf8')); } catch { /* none */ } }
  const sc = score(task, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const row = { ts: new Date().toISOString(), task: task.id, model, rep, id, state: m?.[2] || `exit${r.code}`, secs, tokens: st.tokens || 0, tools: st.tool_calls || 0, ...sc };
  fs.appendFileSync(RESULTS, JSON.stringify(row) + '\n');
  return row;
}

async function main() {
  if (arg('selftest')) process.exit(selftest());
  fs.mkdirSync(BENCH_HOME, { recursive: true });
  if (arg('report')) return report(list(arg('models')));
  const models = list(arg('models'));
  if (!models.length) { console.error('give --models id,id (e.g. gemini-4-carbon-low,gpt-6-luna:low)'); process.exit(2); }
  const pool = SETS[arg('set', 'all')] || TASKS;
  const tasks = list(arg('tasks')).length ? TASKS.filter((t) => list(arg('tasks')).includes(t.id)) : pool;
  const reps = Number(arg('reps', 1));
  const timeout = typeof arg('timeout') === 'string' ? arg('timeout') : '8m';
  // One lane per backend, in parallel; inside a lane runs are serial (the relay allows one per backend).
  const lanes = {};
  for (const m of models) (lanes[backendOf(m)] ||= []).push(m);
  const total = models.length * tasks.length * reps; let done = 0;
  await Promise.all(Object.entries(lanes).map(async ([b, ms]) => {
    for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const model of ms) {
      const row = await one(task, model, rep, timeout);
      console.log(`[${++done}/${total}] ${b.padEnd(8)} ${model.padEnd(38)} ${task.id.padEnd(20)} ${row.pass ? 'PASS' : 'fail'}  ${row.state.padEnd(10)} ${String(row.secs).padStart(4)}s ${String(Math.round(row.tokens / 1000)).padStart(5)}k tok${row.tampered ? '  TAMPERED' : ''}${row.visible && !row.hidden ? '  (visible ok, hidden fail)' : ''}`);
    }
  }));
  report(models);
}

function report(only = []) {
  let rows = [];
  try { rows = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  if (only.length) rows = rows.filter((r) => only.includes(r.model));
  const by = {};
  for (const r of rows) (by[r.model] ||= []).push(r);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const ids = [...new Set(rows.map((r) => r.task))];
  const lines = Object.entries(by).map(([model, rs]) => {
    const pass = rs.filter((r) => r.pass).length;
    const cells = ids.map((t) => { const x = rs.filter((r) => r.task === t); return x.length ? `${x.filter((r) => r.pass).length}/${x.length}` : '-'; });
    return { model, pass, n: rs.length, cells, secs: med(rs.map((r) => r.secs)), ktok: Math.round(med(rs.map((r) => r.tokens)) / 1000), vis: rs.filter((r) => r.visible && !r.hidden).length, tam: rs.filter((r) => r.tampered).length };
  }).sort((a, b) => b.pass / b.n - a.pass / a.n || a.secs - b.secs);
  const w = Math.max(...lines.map((l) => l.model.length), 5);
  console.log(`\n${'model'.padEnd(w)}  pass   ${ids.map((i) => i.slice(0, 9).padEnd(9)).join(' ')}  med s  med ktok  overfit  tampered`);
  for (const l of lines) console.log(`${l.model.padEnd(w)}  ${`${l.pass}/${l.n}`.padEnd(5)}  ${l.cells.map((c) => c.padEnd(9)).join(' ')}  ${String(l.secs).padStart(5)}  ${String(l.ktok).padStart(8)}  ${String(l.vis).padStart(7)}  ${String(l.tam).padStart(8)}`);
  console.log('\noverfit = visible test passed but hidden test failed.');
}

main();
