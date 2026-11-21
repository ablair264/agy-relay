// Codex CLI backend: `codex exec --json` for one turn, `codex exec resume <thread>`
// to answer a question in the same conversation, and a parser for its JSONL events
// (thread.started, item.started/completed, turn.completed/failed, error).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, readJSON, writeJSON } from '../store.mjs';

export const name = 'codex';
export const label = 'codex';

// PATH first: a stale global install (e.g. /usr/local/bin) can shadow the one the
// user actually runs (often under nvm). Fixed paths only when codex is not on PATH.
const onPath = () => { const r = spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
export const BIN = process.env.CODEX_BIN || onPath()
  || ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex')].find((p) => fs.existsSync(p))
  || 'codex';

// Cheapest first: model:reasoning effort. Same length as the agy ladder so a kind's
// starting rung means roughly the same tier on either backend.
export const LADDER = [
  'gpt-6-luna:low',
  'gpt-6-luna:medium',
  'gpt-6.2-sol:low',      // Sol 6.2 and Astra 6.2 replace Sol 6.1 and Astra 6 (Nov 2026)
  'gpt-6.2-sol:medium',
  'gpt-6.2-sol:high',
  'gpt-6.2-astra:medium',
];

export const EXTRA = [];
export const owns = (model) => /^(gpt-|o\d|codex-)/.test(model);
// Codex reasons silently for long stretches at high effort, so allow more quiet time.
export const defaults = { stall_s: 480, startup_s: 90 };
export const LONG_TOOL = /^shell$/;
export const hookHint = 'check the hooks in ~/.codex/config.toml';
export const childEnv = () => ({ ...process.env });

let have = null;
export function installed() {
  if (have === null) have = spawnSync(BIN, ['--version'], { encoding: 'utf8', timeout: 15e3 }).status === 0;
  return have;
}

const MODELS_CACHE = path.join(HOME, 'codex-models.json');
const LIMIT_FILE = path.join(HOME, 'codex-limit.json');

// `codex debug models` lists every model with its reasoning levels; ids are model:effort.
export function listModels({ refresh = false } = {}) {
  const cache = readJSON(MODELS_CACHE);
  if (!refresh && cache && Date.now() - cache.at < 24 * 3600e3) return cache.models;
  try {
    const r = spawnSync(BIN, ['debug', 'models'], { encoding: 'utf8', timeout: 45e3, maxBuffer: 64 << 20 });
    const out = r.stdout || '';
    const j = JSON.parse(out.slice(out.indexOf('{')));
    const models = [];
    for (const m of j.models || []) {
      if (m.visibility !== 'list') continue;
      for (const l of m.supported_reasoning_levels || []) models.push({ id: `${m.slug}:${l.effort}`, name: `${m.display_name || m.slug} ${l.effort}` });
    }
    if (models.length) { writeJSON(MODELS_CACHE, { at: Date.now(), models }); return models; }
  } catch { /* fall through to stale cache */ }
  return cache?.models || [];
}

// Remaining Codex usage, read from `codex app-server` (account/rateLimits/read: no
// model turn) and cached 10 min. Fractions are what is LEFT (0..1), like agy's.
// The reset time from the last "usage limit" error also counts, in case the read fails.
const QUOTA_CACHE = path.join(HOME, 'codex-quota.json');
const LIMITS_JS = path.join(path.dirname(new URL(import.meta.url).pathname), 'codex-limits.mjs');

export function quota({ refresh = false } = {}) {
  const l = readJSON(LIMIT_FILE);
  const learned = l && l.until > Date.now() ? l.until : null;
  let cache = readJSON(QUOTA_CACHE);
  if (refresh || !cache || Date.now() - cache.at > 10 * 60e3) {
    try {
      const r = spawnSync(process.execPath, [LIMITS_JS, BIN], { encoding: 'utf8', timeout: 20e3 });
      const j = JSON.parse(r.stdout || '{}');
      if (j.rateLimits) {
        const rl = j.rateLimits;
        const left = (w) => (w && typeof w.usedPercent === 'number' ? Math.max(0, 1 - w.usedPercent / 100) : null);
        const at = (w) => (w?.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null);
        cache = { at: Date.now(), quota: {
          codex5h: left(rl.primary), codexWeek: left(rl.secondary), allowed: j.ordinaryUsageAllowed !== false,
          resets: { codex5h: at(rl.primary), codexWeek: at(rl.secondary) }, plan: rl.planType || null,
        } };
        writeJSON(QUOTA_CACHE, cache);
      }
    } catch { /* keep the stale cache */ }
  }
  const q = cache?.quota || { codex5h: null, codexWeek: null, allowed: true, resets: {} };
  // A window at 0 left, or usage not allowed, means limited until the latest such reset.
  let until = learned;
  for (const k of ['codex5h', 'codexWeek']) if (q[k] !== null && q[k] <= 0 && q.resets[k]) until = Math.max(until || 0, Date.parse(q.resets[k]));
  if (!q.allowed && !until) until = Date.now() + 3600e3;
  return { ...q, limitedUntil: until && until > Date.now() ? until : null, message: l?.message || null };
}

// What is left in the tighter window, or null when unknown.
export function headroom() {
  const q = quota();
  const v = [q.codex5h, q.codexWeek].filter((x) => x !== null);
  return v.length ? Math.min(...v) : null;
}

export function blocked() {
  const q = quota();
  if (q.limitedUntil) return `Codex usage limit until ${new Date(q.limitedUntil).toLocaleString()}`;
  const h = headroom();
  return h !== null && h < 0.05 ? `Codex usage at ${Math.round(h * 100)}% left` : null;
}

export function adjust(rung) { return rung; }

// "…try again at Nov 13th, 2026 8:32 PM." -> epoch ms (5 h from now if unparseable).
export function limitUntil(msg) {
  const m = String(msg).match(/try again at ([^.]+)/i);
  const t = m ? Date.parse(m[1].replace(/(\d+)(st|nd|rd|th)\b/, '$1').trim()) : NaN;
  return Number.isFinite(t) ? t : Date.now() + 5 * 3600e3;
}
export const isLimit = (msg) => /usage limit|rate limit|quota/i.test(String(msg || ''));
export function recordLimit(msg) { writeJSON(LIMIT_FILE, { at: Date.now(), until: limitUntil(msg), message: String(msg).slice(0, 300) }); }

const split = (model) => { const i = model.lastIndexOf(':'); return i > 0 ? [model.slice(0, i), model.slice(i + 1)] : [model, null]; };

export function command(meta, prompt, { conversation, schemaPath, lastPath }) {
  const [model, effort] = split(meta.model);
  const sandbox = meta.write ? 'workspace-write' : 'read-only';
  const opts = ['--json', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', lastPath, '-m', model,
    '-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"'];
  if (effort) opts.push('-c', `model_reasoning_effort="${effort}"`);
  // resume has no -C/-s; the process cwd is the workspace and -c sets the sandbox.
  const args = conversation ? ['exec', 'resume', conversation, ...opts, prompt] : ['exec', '-C', meta.dir, ...opts, prompt];
  return { bin: meta.bin || BIN, args };
}

// Codex wraps shell commands as `/bin/zsh -lc '<cmd>'`; show just the command.
const unwrap = (c) => {
  const s = Array.isArray(c) ? c.join(' ') : String(c ?? '');
  const m = s.match(/^\S*\/?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/);
  return m ? m[2] : s;
};
const rel = (p, dir) => String(p ?? '').split(`${dir}/`).join('');

function toolOf(it, dir) {
  switch (it.type) {
    case 'command_execution': return { tool: 'shell', arg: rel(unwrap(it.command), dir).replace(/\s+/g, ' ').slice(0, 90), sig: `shell:${unwrap(it.command)}` };
    case 'file_change': {
      const files = (it.changes || []).map((c) => c.path).filter(Boolean);
      return { tool: 'edit', arg: files.map((f) => rel(f, dir)).join(', ').slice(0, 90), sig: `edit:${JSON.stringify(it.changes || [])}`, files };
    }
    case 'mcp_tool_call': return { tool: `${it.server}.${it.tool}`, arg: JSON.stringify(it.arguments ?? '').slice(0, 90), sig: `mcp:${it.server}.${it.tool}:${JSON.stringify(it.arguments ?? '')}` };
    case 'web_search': return { tool: 'web_search', arg: String(it.query || '').slice(0, 90), sig: `web:${it.query}` };
    default: return null;
  }
}

export function parser(meta) {
  let last = '';
  return (ev) => {
    const out = [];
    const it = ev.item || {};
    if (ev.type === 'thread.started') {
      out.push({ k: 'pickup', id: ev.thread_id });
    } else if (ev.type === 'item.started') {
      const t = toolOf(it, meta.dir);
      if (t) out.push({ k: 'tool_start', tool: t.tool, arg: t.arg });
      else if (it.type === 'reasoning') out.push({ k: 'busy', what: 'thinking' });
    } else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message') { last = it.text || ''; out.push({ k: 'text', t: last, replace: true }); }
      else if (it.type === 'reasoning') out.push({ k: 'idle', what: 'thinking' });
      else if (it.type === 'error') out.push({ k: 'warn', msg: it.message });
      else {
        const t = toolOf(it, meta.dir);
        if (t) {
          const ok = !/failed|declined/.test(it.status || '');
          const msg = ok ? '' : String(it.aggregated_output || it.error?.message || `exit ${it.exit_code ?? '?'}`).replace(/\s+/g, ' ').slice(-300);
          out.push({ k: 'tool_end', ...t, files: ok ? t.files || [] : [], ok, msg, hook: /hook/i.test(msg) && /denied|blocked/i.test(msg) });
        }
      }
    } else if (ev.type === 'turn.completed') {
      const u = ev.usage || {};
      const total = (u.input_tokens || 0) + (u.output_tokens || 0);
      out.push({ k: 'tokens', n: total, absolute: true });
      out.push({ k: 'result', ok: true, response: last, usage: { total, input: u.input_tokens, output: u.output_tokens, cached: u.cached_input_tokens, thinking: u.reasoning_output_tokens } });
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      const msg = ev.error?.message || ev.message || 'codex error';
      if (isLimit(msg)) { recordLimit(msg); out.push({ k: 'limit', msg }); }
      if (ev.type === 'turn.failed') out.push({ k: 'result', ok: false, response: last || msg, error: msg });
      else out.push({ k: 'warn', msg });
    }
    return out;
  };
}
