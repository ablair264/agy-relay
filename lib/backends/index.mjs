// The workers the relay can hand a task to. Each backend module exports the same
// shape: name, LADDER, owns(model), installed(), listModels(), quota(), blocked(),
// adjust(), command(), parser(), defaults, LONG_TOOL, hookHint, childEnv.
import * as agy from './agy.mjs';
import * as codex from './codex.mjs';

export const BACKENDS = { agy, codex };
export const ORDER = ['agy', 'codex'];
export const ALL_LADDER = ORDER.flatMap((b) => BACKENDS[b].LADDER);
// Every model a backend may run, ladder first: what the Settings tab lists.
export const MODELS = Object.fromEntries(ORDER.map((b) => [b, [...BACKENDS[b].LADDER, ...(BACKENDS[b].EXTRA || [])]]));

export function backendOf(model) {
  for (const b of ORDER) if (BACKENDS[b].owns(model)) return b;
  return 'agy';
}

export function getBackend(nameOrModel) {
  return BACKENDS[nameOrModel] || BACKENDS[backendOf(nameOrModel)];
}
