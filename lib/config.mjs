// User settings in $AGENT_HANDOFF_HOME/config.json. Env vars override for one shell.
//   backend:   auto | agy | codex   which worker `run` uses when --backend is not given
//   autobench: true | false         auto-benchmarking: Claude reviews and rates every
//                                   finished handoff on its own, and the ratings steer
//                                   routing (see SKILL.md "Auto-benchmarking")
//   workers:   { agy, codex }       which workers may be used at all
//   disabled_models: [id]           models routing never picks
//   limits:    { low, stop }        usage-left cut-offs (0..1): below `low` prefer the
//                                   other worker; below `stop` never use this one
// The pane's Settings tab edits all of these through `agent-handoff config`.
import path from 'node:path';
import { HOME, readJSON, writeJSON } from './store.mjs';
import { BACKENDS, ORDER } from './backends/index.mjs';

export const CONFIG = path.join(HOME, 'config.json');
export const DEFAULTS = {
  backend: 'auto',
  autobench: true,
  workers: { agy: true, codex: true },
  disabled_models: [],
  limits: { low: 0.2, stop: 0 },
};
const BACKEND_VALUES = ['auto', ...ORDER];
const off = (v) => /^(0|off|false|no)$/i.test(String(v));
const on = (v) => /^(1|on|true|yes)$/i.test(String(v));
const KEYS = 'backend, autobench, worker, model, limit';

// Defaults filled in, nested objects merged, and the pre-rename `bench` key read.
function stored() {
  const raw = readJSON(CONFIG, {}) || {};
  const c = {
    ...DEFAULTS,
    ...raw,
    workers: { ...DEFAULTS.workers, ...(raw.workers || {}) },
    limits: { ...DEFAULTS.limits, ...(raw.limits || {}) },
    disabled_models: Array.isArray(raw.disabled_models) ? raw.disabled_models : [],
  };
  if (raw.autobench === undefined && raw.bench !== undefined) c.autobench = raw.bench !== false;
  delete c.bench;
  return c;
}

export function config() {
  const c = stored();
  if (process.env.AGENT_HANDOFF_AUTOBENCH !== undefined) c.autobench = !off(process.env.AGENT_HANDOFF_AUTOBENCH);
  if (process.env.AGENT_HANDOFF_BACKEND) c.backend = process.env.AGENT_HANDOFF_BACKEND;
  return c;
}

export const workerOn = (c, b) => c.workers?.[b] !== false;
export const modelOn = (c, m) => !(c.disabled_models || []).includes(m);

// on | off | toggle, applied to a current boolean.
function flip(cur, value, what) {
  if (value === undefined || value === 'toggle') return !cur;
  if (on(value) || off(value)) return on(value);
  throw new Error(`${what} must be on, off or toggle`);
}

// "25", "25%" or "0.25" -> 0.25
function fraction(v) {
  const n = parseFloat(String(v ?? '').replace('%', ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('a limit is a percentage from 0 to 100');
  return Math.round((n > 1 || String(v).includes('%') ? n / 100 : n) * 100) / 100;
}

// setConfig('autobench', 'off'), setConfig('worker', 'codex', 'off'),
// setConfig('model', 'gpt-6-luna:low', 'off'), setConfig('limit', 'stop', '10')
export function setConfig(key, ...args) {
  const c = stored();
  const [a, b] = args;
  if (key === 'autobench' || key === 'bench') {
    c.autobench = flip(c.autobench, a, 'autobench');
  } else if (key === 'backend') {
    if (!BACKEND_VALUES.includes(a)) throw new Error(`backend must be one of ${BACKEND_VALUES.join(', ')}`);
    c.backend = a;
  } else if (key === 'worker') {
    if (!ORDER.includes(a)) throw new Error(`worker must be one of ${ORDER.join(', ')}`);
    c.workers[a] = flip(workerOn(c, a), b, 'worker');
  } else if (key === 'model') {
    if (!a || !ORDER.some((w) => BACKENDS[w].owns(a))) throw new Error(`unknown model ${a ?? ''} (see agent-handoff models)`);
    const want = flip(modelOn(c, a), b, 'model');
    c.disabled_models = want ? c.disabled_models.filter((m) => m !== a) : [...new Set([...c.disabled_models, a])];
  } else if (key === 'limit') {
    if (!['low', 'stop'].includes(a)) throw new Error('limit is low (prefer the other worker below this) or stop (never use a worker below this)');
    c.limits[a] = fraction(b);
  } else throw new Error(`config keys: ${KEYS}`);
  writeJSON(CONFIG, c);
  return c;
}
