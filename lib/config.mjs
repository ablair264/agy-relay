// User settings in $AGENT_HANDOFF_HOME/config.json. Env vars override for one shell.
//   backend:   auto | agy | codex   which worker `run` uses when --backend is not given
//   autobench: true | false         auto-benchmarking: Claude reviews and rates every
//                                   finished handoff on its own, and the ratings steer
//                                   routing (see SKILL.md "Auto-benchmarking")
import path from 'node:path';
import { HOME, readJSON, writeJSON } from './store.mjs';

export const CONFIG = path.join(HOME, 'config.json');
export const DEFAULTS = { backend: 'auto', autobench: true };
const BACKEND_VALUES = ['auto', 'agy', 'codex'];
const off = (v) => /^(0|off|false|no)$/i.test(String(v));
const on = (v) => /^(1|on|true|yes)$/i.test(String(v));

// config.json written before the rename stored the switch as `bench`.
function stored() {
  const c = { ...DEFAULTS, ...readJSON(CONFIG, {}) };
  if (c.bench !== undefined) { if (readJSON(CONFIG, {}).autobench === undefined) c.autobench = c.bench !== false; delete c.bench; }
  return c;
}

export function config() {
  const c = stored();
  if (process.env.AGENT_HANDOFF_AUTOBENCH !== undefined) c.autobench = !off(process.env.AGENT_HANDOFF_AUTOBENCH);
  if (process.env.AGENT_HANDOFF_BACKEND) c.backend = process.env.AGENT_HANDOFF_BACKEND;
  return c;
}

export function setConfig(key, value) {
  const c = stored();
  if (key === 'autobench' || key === 'bench') {
    if (value === undefined || value === 'toggle') c.autobench = !c.autobench;
    else if (on(value) || off(value)) c.autobench = on(value);
    else throw new Error('autobench must be on, off or toggle');
  } else if (key === 'backend') {
    if (!BACKEND_VALUES.includes(value)) throw new Error(`backend must be one of ${BACKEND_VALUES.join(', ')}`);
    c.backend = value;
  } else throw new Error('config keys: backend, autobench');
  writeJSON(CONFIG, c);
  return c;
}
