// Job files, the benchmark ledger and the one-run-at-a-time lock.
// Everything lives under $AGENT_HANDOFF_HOME (default ~/.agent-handoff).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AGENT_HANDOFF_HOME || path.join(os.homedir(), '.agent-handoff');
export const JOBS = path.join(HOME, 'jobs');
export const LEDGER = path.join(HOME, 'ledger.jsonl');

// One-time move of data written before the rename (~/.agy-relay), so the
// ledger and job history carry over.
const OLD_HOME = path.join(os.homedir(), '.agy-relay');
if (!process.env.AGENT_HANDOFF_HOME && !fs.existsSync(HOME) && fs.existsSync(OLD_HOME)) {
  try { fs.renameSync(OLD_HOME, HOME); } catch { /* fall back to a fresh folder */ }
}

fs.mkdirSync(JOBS, { recursive: true });

// The mod (hooks/register.js) has no Node APIs and the Desktop app's PATH may lack
// nvm's node, so record how to call this CLI for its buttons.
try {
  const rt = { node: process.execPath, cli: fs.realpathSync(process.argv[1] || '') };
  if (/agent-handoff$/.test(rt.cli)) fs.writeFileSync(path.join(HOME, 'runtime.json'), JSON.stringify(rt));
} catch { /* not run as the CLI */ }

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function newJobId() {
  const d = new Date();
  const stamp = d.toISOString().slice(5, 16).replace(/[-:T]/g, '');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export const jobDir = (id) => path.join(JOBS, id);
export const jobFile = (id, name) => path.join(JOBS, id, name);

// Accepts a full id, a unique prefix, or nothing (latest job).
export function resolveJob(idOrPrefix) {
  const ids = fs.readdirSync(JOBS).filter((n) => fs.existsSync(jobFile(n, 'meta.json'))).sort();
  if (!ids.length) throw new Error('no jobs yet');
  if (!idOrPrefix) return ids[ids.length - 1];
  const hits = ids.filter((n) => n === idOrPrefix || n.startsWith(idOrPrefix) || n.endsWith(idOrPrefix));
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous id ${idOrPrefix}` : `no job ${idOrPrefix}`);
  return hits[0];
}

export function listJobs(limit = 15) {
  return fs.readdirSync(JOBS).sort().slice(-limit)
    .map((id) => ({ id, meta: readJSON(jobFile(id, 'meta.json'), {}), status: readJSON(jobFile(id, 'status.json'), {}) }));
}

// Ledger: append-only JSONL. Each run turn appends a "run" row; `verify` appends a
// "verdict" row. Readers merge by job id, last row of each type wins.
export function appendLedger(row) {
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

export function readLedger() {
  let text = '';
  try { text = fs.readFileSync(LEDGER, 'utf8'); } catch { return []; }
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const cur = byId.get(row.id) || {};
    if (row.type === 'verdict') byId.set(row.id, { ...cur, verdict: row.verdict, verdict_note: row.note });
    else byId.set(row.id, { ...cur, ...row, verdict: cur.verdict, verdict_note: cur.verdict_note });
  }
  return [...byId.values()].filter((r) => r.type === 'run');
}

// The per-backend run lock and the queue live in queue.mjs.
