// Antigravity (agy) backend: binary lookup, models, quota, the command line
// for one turn, and a parser that turns agy's stream-json into relay events.
// `agy models` has hung on "Fetching available models..." (wiki m8bf9f1b),
// so the model list and quota are cached.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, readJSON, writeJSON } from '../store.mjs';

export const name = 'agy';
export const label = 'agy';

export const BIN = process.env.AGY_BIN
  || [path.join(os.homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'].find((p) => fs.existsSync(p))
  || 'agy';

// Cheapest first. Claude/GPT models agy offers are left out on purpose:
// delegated work through agy goes to Gemini (wiki mf6ad198). Gemini 3.8 Flash
// is retired. Picked from Artificial Analysis figures (Nov 2026): each rung is
// the cheapest model at its level. Left out because something cheaper scores
// higher: Hydrogen medium (Neon low), Hydrogen xhigh (Neon high), every Argon
// effort (Neon). Carbon is not offered by agy. Argon has its own weekly pool,
// so it is kept as an overflow when the shared Gemini pool runs low.
export const LADDER = [
  'gemini-4-hydrogen-low',  // $0.29/task, 1.5 min: lookups and digests only
  'gemini-4-neon-low',      // $0.75, Terminal-Bench 33%
  'gemini-4-hydrogen-high', // $1.87, TB 54%
  'gemini-4-neon-medium',   // $1.90, TB 55%, Intelligence 55
  'gemini-4-neon-high',     // $3.74, TB 62%
  'gemini-4-neon-xhigh',    // $6.44, TB 64%
];
// Not on the ladder, but used as an overflow pool; listed so they can be switched off.
export const EXTRA = ['gemini-4-argon-medium', 'gemini-4-argon-high'];
// The lower three rungs overflow to Argon medium, the upper three to Argon high.
const overflowFor = (model) => {
  const i = LADDER.indexOf(model);
  return i < 0 ? null : i < 3 ? 'gemini-4-argon-medium' : 'gemini-4-argon-high';
};

export const owns = (model) => /^gemini-/.test(model);
export const defaults = { stall_s: 240, startup_s: 90 };
export const LONG_TOOL = /^run_command$/;
export const hookHint = 'check ~/.gemini/config/hooks.json';

export const childEnv = () => ({ ...process.env });

let have = null;
export function installed() {
  if (have === null) have = spawnSync(BIN, ['--version'], { encoding: 'utf8', timeout: 15e3 }).status === 0;
  return have;
}

const MODELS_CACHE = path.join(HOME, 'models.json');
const QUOTA_CACHE = path.join(HOME, 'quota.json');

function agySync(args, timeoutMs) {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: timeoutMs, env: childEnv() });
  if (r.error) throw r.error;
  return r.stdout || '';
}

const fresh = (cache, maxAgeMs) => cache && Date.now() - cache.at < maxAgeMs;

// Returns [{id, name}] using the id column, which is what --model wants (wiki md3fc689).
export function listModels({ refresh = false } = {}) {
  const cache = readJSON(MODELS_CACHE);
  if (!refresh && fresh(cache, 24 * 3600e3)) return cache.models;
  try {
    const models = agySync(['models'], 45e3).split('\n')
      .map((l) => l.split('\t'))
      .filter((c) => c.length >= 2 && /^[a-z0-9.-]+$/.test(c[0].trim()))
      .map(([id, n]) => ({ id: id.trim(), name: n.trim() }));
    if (models.length) { writeJSON(MODELS_CACHE, { at: Date.now(), models }); return models; }
  } catch { /* fall through to stale cache */ }
  return cache?.models || [];
}

// `agy -p /usage` costs no model turn (wiki md1ecf9e). Returns fractions 0..1 or null.
export function quota({ refresh = false } = {}) {
  const cache = readJSON(QUOTA_CACHE);
  if (!refresh && fresh(cache, 10 * 60e3)) return cache.quota;
  const q = { gemini5h: null, geminiWeek: null, argonWeek: null, otherWeek: null, resets: {} };
  try {
    const out = JSON.parse(agySync(['-p', '/usage', '--output-format', 'json'], 30e3));
    for (const line of String(out.response || '').split('\n')) {
      const [group, lbl, pctStr, reset] = line.split('\t');
      if (!pctStr) continue;
      const v = parseFloat(pctStr) / 100;
      let key = null;
      if (/argon/i.test(group)) key = 'argonWeek';
      else if (/^gemini/i.test(group)) key = /five hour/i.test(lbl) ? 'gemini5h' : 'geminiWeek';
      else if (/weekly/i.test(lbl)) key = 'otherWeek';
      if (key) { q[key] = v; q.resets[key] = reset; }
    }
    writeJSON(QUOTA_CACHE, { at: Date.now(), quota: q });
    return q;
  } catch {
    return cache?.quota || q;
  }
}

// What is left in the tighter window of the shared Gemini pool (Neon, Hydrogen),
// or null when unknown.
function geminiLeft(q) {
  const v = [q.gemini5h, q.geminiWeek].filter((x) => x !== null);
  return v.length ? Math.min(...v) : null;
}
const argonOk = (q) => q.argonWeek !== null && q.argonWeek >= 0.15;

// Usage left for backend choice: the Gemini pool, or Argon's own pool when that
// is what a run would fall back to.
export function headroom() {
  const q = quota();
  const g = geminiLeft(q);
  return g !== null && g < 0.1 && argonOk(q) ? q.argonWeek : g;
}

// null when usable; otherwise why this backend should be skipped.
export function blocked() {
  const q = quota();
  const g = geminiLeft(q);
  if (g !== null && g < 0.05 && !argonOk(q)) {
    return `Gemini quota at ${Math.round(g * 100)}% and Argon weekly at ${q.argonWeek === null ? '?' : `${Math.round(q.argonWeek * 100)}%`}`;
  }
  return null;
}

// Quota-driven moves on the ladder after the ledger has had its say.
export function adjust(rung, ladder, reasons, pct) {
  const q = quota();
  if (q.gemini5h !== null && q.gemini5h < 0.1) reasons.push(`warning: Gemini 5-hour quota at ${pct(q.gemini5h)}`);
  if (q.geminiWeek !== null && q.geminiWeek < 0.1) reasons.push(`warning: Gemini weekly quota at ${pct(q.geminiWeek)}`);
  return rung;
}

// When the shared Gemini pool is nearly spent, swap the ladder model for Argon,
// which draws on its own weekly pool. Returns the replacement id or null.
export function overflow(model, available, reasons, pct) {
  const q = quota();
  const g = geminiLeft(q);
  if (g === null || g >= 0.1 || !argonOk(q)) return null;
  const to = overflowFor(model);
  if (!to || (available.size && !available.has(to))) return null;
  reasons.push(`Gemini pool at ${pct(g)}, Argon weekly at ${pct(q.argonWeek)}: using ${to}`);
  return to;
}

export function command(meta, prompt, { conversation, schemaPath }) {
  const args = ['-p', prompt, '--model', meta.model, '--output-format', 'stream-json',
    '--json-schema', schemaPath, '--print-timeout', `${meta.timeout_s}s`, '--add-dir', meta.dir,
    '--mode', meta.write ? 'accept-edits' : 'plan'];
  if (meta.sandbox) args.push('--sandbox');
  if (conversation) args.push('--conversation', conversation);
  return { bin: meta.bin || BIN, args };
}

// One short argument per tool call for the heartbeat, paths relative to the workspace.
const brief1 = (p, dir) => {
  if (!p) return '';
  const v = p.Path || p.AbsolutePath || p.TargetFile || p.CommandLine || p.Query || p.Url || Object.values(p)[0];
  return String(v ?? '').split(`${dir}/`).join('').replace(/\s+/g, ' ').slice(0, 90);
};
const WRITE_TOOLS = /write|replace|edit|sed_file|notebook_edit/;

// Returns a function: one parsed stream-json object -> a list of relay events
// (pickup, steps, tokens, text, tool_start, tool_end, busy, idle, result).
export function parser(meta) {
  return (ev) => {
    const out = [];
    if (ev.event === 'init') {
      out.push({ k: 'pickup', id: ev.conversation_id });
    } else if (ev.event === 'step_update') {
      const u = ev.step_update;
      out.push({ k: 'steps', n: (u.step_index ?? 0) + 1 });
      if (u.usage?.total_tokens) out.push({ k: 'tokens', n: u.usage.total_tokens });
      if (u.text_delta) out.push({ k: 'text', t: u.text_delta });
      if (u.step_type === 'tool') {
        const p = u.tool_info?.parameters;
        const arg = brief1(p, meta.dir);
        if (u.state === 'ACTIVE') {
          out.push({ k: 'tool_start', tool: u.tool_name, arg, step: u.step_index });
        } else {
          const ok = u.state !== 'ERROR';
          const msg = String(u.tool_info?.error?.message || '').replace(/\s+/g, ' ');
          const f = p && (p.TargetFile || p.AbsolutePath || p.Path || p.FilePath || p.file_path);
          out.push({
            k: 'tool_end', tool: u.tool_name, arg, step: u.step_index, ok, msg, dur: u.duration_seconds,
            sig: `${u.tool_name}:${JSON.stringify(p || {})}`, hook: /pre-tool hook/.test(msg),
            files: ok && f && WRITE_TOOLS.test(u.tool_name || '') ? [String(f)] : [],
          });
        }
      } else if (u.state === 'ACTIVE') {
        out.push({ k: 'busy', what: u.step_type });
      } else {
        out.push({ k: 'idle', what: u.step_type });
      }
    } else if (ev.event === 'result') {
      const r = ev.result || {};
      const u = r.usage || {};
      out.push({
        k: 'result', ok: r.status === 'SUCCESS', response: r.response,
        usage: { total: u.total_tokens, input: u.input_tokens, output: u.output_tokens, thinking: u.thinking_tokens },
      });
    }
    return out;
  };
}
