// Routing: pick the backend (agy or codex), then a model on that backend's cost
// ladder. With auto-benchmarking on, the ledger (success rates from past runs) moves both
// choices; with it off, each kind starts at a fixed rung and quota is the only input.
import { readLedger } from './store.mjs';
import { config } from './config.mjs';
import { ALL_LADDER, BACKENDS, ORDER, backendOf } from './backends/index.mjs';

// Kept for callers that sort by cost: every backend's ladder, cheapest first within each.
export const LADDER = ALL_LADDER;

// kind -> [starting rung, writes files?]
export const KINDS = {
  search:    [0, false], // web / docs lookup returning a digest
  analysis:  [1, false], // read code or data, report facts with file:line
  review:    [4, false], // first-pass review of a diff
  scaffold:  [1, true],  // boilerplate, repetitive files
  tests:     [1, true],  // generate tests against a spec
  implement: [2, true],  // a real code change
};

const KIND_HINTS = [
  ['review', /\breview|audit|critique\b/i],
  ['tests', /\b(write|generate|add)\b.*\btests?\b|\btest suite\b/i],
  ['scaffold', /\bscaffold|boilerplate|stub out|generate (the )?files\b/i],
  ['search', /\bsearch (the )?web|latest|look up|find (the )?docs|release notes\b/i],
  ['implement', /\bimplement|refactor|migrate|fix|add (a|the)\b|build\b/i],
];

export function detectKind(task, write) {
  for (const [kind, re] of KIND_HINTS) {
    if (re.test(task) && (write || !KINDS[kind][1])) return kind;
  }
  return write ? 'implement' : 'analysis';
}

// Score one ledger row. A Claude verdict counts fully, a test gate counts fully,
// the worker's own "done" counts half: it has reported success on broken work before.
function score(r) {
  if (r.state === 'cancelled' || r.state === 'stalled_startup' || r.state === 'limited') return null;
  if (r.verdict) return { s: { pass: 1, partial: 0.5 }[r.verdict] ?? 0, w: 1 };
  if (typeof r.tests_pass === 'boolean') return { s: r.tests_pass ? 1 : 0, w: 1 };
  return { s: r.state === 'done' ? 1 : 0, w: 0.5 };
}

export function stats(rows = readLedger()) {
  const out = {};
  for (const r of rows) {
    const sc = score(r);
    if (!sc) continue;
    const k = `${r.kind}|${r.model}`;
    const o = (out[k] ||= { kind: r.kind, model: r.model, backend: r.backend || backendOf(r.model), n: 0, ok: 0, runs: 0, secs: [], tokens: [], stalls: 0, questions: 0 });
    o.n += sc.w; o.ok += sc.s * sc.w; o.runs++;
    if (r.duration_s) o.secs.push(r.duration_s);
    if (r.tokens?.total) o.tokens.push(r.tokens.total);
    if (/stall|loop/.test(r.state)) o.stalls++;
    if (r.questions) o.questions += r.questions;
  }
  for (const o of Object.values(out)) o.rate = o.n ? o.ok / o.n : null;
  return out;
}

const MIN_N = 3;        // weighted runs before the ledger can move a choice
const ESCALATE_BELOW = 0.7;
const DESCEND_ABOVE = 0.85;
const EXPLORE_RATE = Number(process.env.AGENT_HANDOFF_EXPLORE ?? 0.2);
const LOW_ROOM = 0.2;   // below this much usage left, prefer the other backend

// A backend's pass rate on one kind, over every model it has run it with.
function backendRate(st, b, kind) {
  let n = 0, ok = 0;
  for (const s of Object.values(st)) if (s.kind === kind && s.backend === b) { n += s.n; ok += s.ok; }
  return { n, rate: n ? ok / n : null };
}

function pickBackend({ want, kind, bench, explore, st, reasons }) {
  const have = ORDER.filter((b) => BACKENDS[b].installed());
  if (!have.length) throw new Error('neither agy nor codex is installed (or on PATH)');
  if (want && want !== 'auto') {
    if (!BACKENDS[want]) throw new Error(`unknown backend ${want} (use: auto, ${ORDER.join(', ')})`);
    if (!have.includes(want)) throw new Error(`${want} is not installed (or not on PATH)`);
    const why = BACKENDS[want].blocked();
    reasons.push(`backend ${want} (chosen)${why ? `; warning: ${why}` : ''}`);
    return want;
  }
  let ok = have.filter((b) => {
    const why = BACKENDS[b].blocked();
    if (why) reasons.push(`skipping ${b}: ${why}`);
    return !why;
  });
  if (!ok.length) { ok = have; reasons.push('every backend reports a limit; trying anyway'); }
  if (ok.length === 1) { reasons.push(`backend ${ok[0]} (only one available)`); return ok[0]; }
  // Usage left (tighter of the 5-hour and weekly windows). A backend nearly out
  // loses to one with plenty left before the ledger is consulted.
  const room = Object.fromEntries(ok.map((b) => [b, BACKENDS[b].headroom()]));
  reasons.push(`usage left: ${ok.map((b) => `${b} ${pct(room[b])}`).join(', ')}`);
  const low = ok.filter((b) => room[b] !== null && room[b] < LOW_ROOM);
  const roomy = ok.filter((b) => !low.includes(b));
  if (low.length && roomy.length) {
    reasons.push(`backend ${roomy[0]}: ${low.join(', ')} under ${pct(LOW_ROOM)} usage left`);
    return roomy[0];
  }
  if (bench) {
    const r = ok.map((b) => ({ b, ...backendRate(st, b, kind) }));
    const known = r.filter((x) => x.n >= MIN_N);
    const unknown = r.filter((x) => x.n < MIN_N);
    if (explore && unknown.length && Math.random() < EXPLORE_RATE) {
      const x = unknown[0];
      reasons.push(`backend ${x.b}: exploring (only ${x.n.toFixed(1)} weighted ${kind} runs)`);
      return x.b;
    }
    if (known.length) {
      const best = known.sort((a, b) => b.rate - a.rate)[0];
      reasons.push(`backend ${best.b}: passes ${pct(best.rate)} of ${kind} runs${known.length > 1 ? ` (best of ${known.map((x) => `${x.b} ${pct(x.rate)}`).join(', ')})` : ''}`);
      return best.b;
    }
  }
  // No ledger verdict: the one with more usage left, else default order.
  const known = ok.filter((b) => room[b] !== null);
  if (known.length === ok.length) {
    const best = [...ok].sort((a, b) => room[b] - room[a])[0];
    reasons.push(`backend ${best}: most usage left`);
    return best;
  }
  reasons.push(`backend ${ok[0]} (default order)`);
  return ok[0];
}

export function route({ task, kind, write = false, complex = false, model, backend, explore = true }) {
  const reasons = [];
  const cfg = config();
  const bench = cfg.autobench;
  kind = kind || detectKind(task || '', write);
  if (!KINDS[kind]) throw new Error(`unknown kind ${kind} (use: ${Object.keys(KINDS).join(', ')})`);

  if (model) {
    const b = backendOf(model);
    const be = BACKENDS[b];
    const available = new Set(be.listModels().map((m) => m.id));
    if (available.size && !available.has(model)) throw new Error(`model ${model} not available to ${b}`);
    return { kind, model, backend: b, reasons: ['pinned with --model'], ladder: be.LADDER, bench };
  }

  const st = bench ? stats() : {};
  const b = pickBackend({ want: backend || cfg.backend, kind, bench, explore, st, reasons });
  const be = BACKENDS[b];
  const available = new Set(be.listModels().map((m) => m.id));
  const ladder = be.LADDER.filter((m) => !available.size || available.has(m));
  if (!ladder.length) throw new Error(`none of the ${b} ladder models are available`);

  const at = (i) => Math.max(0, Math.min(ladder.length - 1, i));
  let rung = at(KINDS[kind][0] + (complex ? 2 : 0));
  reasons.push(`prior for ${kind}${complex ? ' (+2 complex)' : ''}: ${ladder[rung]}`);

  if (bench) {
    const s = (i) => st[`${kind}|${ladder[i]}`];
    while (rung < ladder.length - 1 && s(rung)?.n >= MIN_N && s(rung).rate < ESCALATE_BELOW) {
      reasons.push(`${ladder[rung]} passes ${pct(s(rung).rate)} of ${kind} runs, escalating`);
      rung++;
    }
    if (rung > 0 && s(rung - 1)?.n >= MIN_N && s(rung - 1).rate >= DESCEND_ABOVE) {
      rung--;
      reasons.push(`${ladder[rung]} passes ${pct(s(rung).rate)} of ${kind} runs, stepping down`);
    } else if (explore && rung > 0 && !(s(rung - 1)?.n >= MIN_N) && Math.random() < EXPLORE_RATE) {
      rung--;
      reasons.push(`exploring cheaper ${ladder[rung]} (only ${(s(rung)?.n || 0).toFixed(1)} weighted runs)`);
    }
  } else reasons.push('auto-benchmarking off: fixed starting rung, no ledger');

  rung = at(be.adjust(rung, ladder, reasons, pct));
  const pick = be.overflow?.(ladder[rung], available, reasons, pct) || ladder[rung];
  return { kind, model: pick, backend: b, reasons, ladder, bench, stats: st[`${kind}|${pick}`] || null };
}

export const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
