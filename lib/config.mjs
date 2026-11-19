// User settings in $AGY_RELAY_HOME/config.json. Env vars override for one shell.
//   backend: auto | agy | codex   which worker `run` uses when --backend is not given
//   bench:   true | false         benchmark mode (see SKILL.md "Benchmark")
import path from 'node:path';
import { HOME, readJSON, writeJSON } from './store.mjs';

export const CONFIG = path.join(HOME, 'config.json');
export const DEFAULTS = { backend: 'auto', bench: true };
const BACKEND_VALUES = ['auto', 'agy', 'codex'];
const off = (v) => /^(0|off|false|no)$/i.test(String(v));

export function config() {
  const c = { ...DEFAULTS, ...readJSON(CONFIG, {}) };
  if (process.env.AGY_RELAY_BENCH !== undefined) c.bench = !off(process.env.AGY_RELAY_BENCH);
  if (process.env.AGY_RELAY_BACKEND) c.backend = process.env.AGY_RELAY_BACKEND;
  return c;
}

export function setConfig(key, value) {
  const c = { ...DEFAULTS, ...readJSON(CONFIG, {}) };
  if (key === 'bench') c.bench = !off(value);
  else if (key === 'backend') {
    if (!BACKEND_VALUES.includes(value)) throw new Error(`backend must be one of ${BACKEND_VALUES.join(', ')}`);
    c.backend = value;
  } else throw new Error('config keys: backend, bench');
  writeJSON(CONFIG, c);
  return c;
}
