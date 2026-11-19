// One run per backend at a time (concurrent agy print runs hang each other,
// wiki ma034931), with a first-come queue for the rest.
//
// Lock: $HOME/run-<backend>.lock, taken by exclusive create so two sessions
// starting together cannot both win. A lock whose pid is gone is stale.
// Queue: one file per waiter in $HOME/queue/, named <backend>-<ms>-<pid>.json;
// filename order is arrival order. Waiters whose pid is gone are dropped.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readJSON } from './store.mjs';

const QDIR = path.join(HOME, 'queue');
const LEGACY_LOCK = path.join(HOME, 'run.lock'); // pre-queue relays (agy only)
const lockFile = (b) => path.join(HOME, `run-${b}.lock`);

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// null when this process holds the lock now; otherwise who holds it.
export function tryLock(backend, id) {
  if (backend === 'agy') {
    const old = readJSON(LEGACY_LOCK);
    if (old && old.pid !== process.pid && pidAlive(old.pid)) return old;
  }
  const f = lockFile(backend);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(f, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, id, backend, since: new Date().toISOString() }));
      fs.closeSync(fd);
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readJSON(f);
      if (held && held.pid === process.pid) return null;
      if (held && pidAlive(held.pid)) return held;
      fs.rmSync(f, { force: true }); // stale or half-written; try once more
    }
  }
  return readJSON(f) || { id: '?', pid: 0 };
}

export function releaseLock(backend) {
  const f = lockFile(backend);
  const held = readJSON(f);
  if (held && held.pid === process.pid) fs.rmSync(f, { force: true });
}

export function holder(backend) {
  const h = readJSON(lockFile(backend));
  return h && pidAlive(h.pid) ? h : null;
}

function waiters(backend) {
  let names = [];
  try { names = fs.readdirSync(QDIR).filter((n) => n.startsWith(`${backend}-`) && n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const w = readJSON(path.join(QDIR, n));
    if (!w || !pidAlive(w.pid)) { fs.rmSync(path.join(QDIR, n), { force: true }); continue; }
    out.push({ file: n, ...w });
  }
  return out;
}

export function queued(backend) { return waiters(backend); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for this job's turn, then hold the lock. Resolves true when the lock is
// ours, false after maxMs. onWait(ahead, holderRow) is called when the position changes.
export async function waitTurn(backend, id, { maxMs = 4 * 3600e3, onWait = () => {}, pollMs = 2000 } = {}) {
  fs.mkdirSync(QDIR, { recursive: true });
  const name = `${backend}-${String(Date.now()).padStart(15, '0')}-${process.pid}.json`;
  const mine = path.join(QDIR, name);
  fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, id, backend, since: new Date().toISOString() }));
  const drop = () => fs.rmSync(mine, { force: true });
  process.on('exit', drop);
  const t0 = Date.now();
  let last = '';
  try {
    for (;;) {
      const ahead = waiters(backend).filter((w) => w.file < name);
      if (!ahead.length && !tryLock(backend, id)) return true;
      const h = holder(backend) || (backend === 'agy' ? readJSON(LEGACY_LOCK) : null);
      const sig = `${ahead.map((w) => w.id).join(',')}|${h?.id}`;
      if (sig !== last) { last = sig; onWait(ahead, h); }
      if (Date.now() - t0 > maxMs) return false;
      await sleep(pollMs);
    }
  } finally {
    drop();
    process.off('exit', drop);
  }
}
