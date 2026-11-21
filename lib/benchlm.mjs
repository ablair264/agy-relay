// Model prices and benchmark scores from BenchLM (https://benchlm.ai/data/access),
// fetched with the user's own free API key and cached in $AGENT_HANDOFF_HOME/benchlm.json.
//
// BenchLM data is CC BY-NC 4.0: this plugin never ships it. Each user's copy fetches
// it with their own key, keeps it on their machine, and shows the attribution
// ("Data from BenchLM.ai") wherever the numbers appear.
//
// One refresh costs 3 of the free plan's 1,000 monthly reads: the model feed for
// OpenAI and Google, and the coding and agentic rankings. The cache lasts 7 days.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readJSON, writeJSON } from './store.mjs';
import { benchFor, benchKeyOf } from '../hooks/data.js';

export const CACHE = path.join(HOME, 'benchlm.json');
export const KEY_FILE = path.join(HOME, 'benchlm-key');
const BASE = process.env.AGENT_HANDOFF_BENCHLM_URL || 'https://data.benchlm.ai/v1';
const MAX_AGE = 7 * 86400e3;
export const ATTRIBUTION = 'Data from BenchLM.ai';
export const SOURCE_URL = 'https://benchlm.ai';

// The user's key: the env var wins, then the key file (written 0600 by setKey).
export function key() {
  if (process.env.AGENT_HANDOFF_BENCHLM_KEY) return { value: process.env.AGENT_HANDOFF_BENCHLM_KEY.trim(), from: 'AGENT_HANDOFF_BENCHLM_KEY' };
  try { const v = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (v) return { value: v, from: KEY_FILE }; } catch { /* none */ }
  return null;
}

export function setKey(value) {
  if (!value || value === 'off') { fs.rmSync(KEY_FILE, { force: true }); return null; }
  if (!/^[A-Za-z0-9_\-.]{16,200}$/.test(value)) throw new Error('that does not look like a BenchLM data key (create one at https://benchlm.ai/data/access)');
  fs.writeFileSync(KEY_FILE, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(KEY_FILE, 0o600);
  return KEY_FILE;
}

export const keyOf = benchKeyOf;

export const cached = () => readJSON(CACHE);
export const stale = (c = cached()) => !c?.at || Date.now() - c.at > MAX_AGE;

async function get(p, k) {
  const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${k}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20e3) });
  if (res.status === 401 || res.status === 403) throw new Error(`BenchLM refused the key (HTTP ${res.status}); check it at https://benchlm.ai/data/access`);
  if (res.status === 429) throw new Error(`BenchLM rate limit reached; try again ${res.headers.get('retry-after') ? `in ${res.headers.get('retry-after')}s` : 'later'}`);
  if (!res.ok) throw new Error(`BenchLM returned HTTP ${res.status} for ${p.split('?')[0]}`);
  return { body: await res.json(), remaining: Number(res.headers.get('x-data-monthly-remaining') ?? NaN) };
}

const pick = (r) => (r ? { score: r.score ?? null, rank: r.rank ?? null, low: r.scoreInterval90Lower ?? null, high: r.scoreInterval90Upper ?? null, evidence: r.evidenceStatus || null } : null);

// Fetch, merge into one row per model key, and cache. Returns the cache.
export async function refresh({ force = false } = {}) {
  const c = cached();
  if (!force && !stale(c)) return c;
  const k = key();
  if (!k) throw new Error('no BenchLM key: create a free one at https://benchlm.ai/data/access, then run agent-handoff config benchlm-key <key>');
  const feed = await get('/feed/models?creator=OpenAI,Google&limit=250', k.value);
  const coding = await get('/rankings/current?surface=coding&limit=100', k.value);
  const agentic = await get('/rankings/current?surface=agentic&limit=100', k.value);
  const byKey = (b) => Object.fromEntries((b.items || []).map((r) => [r.modelKey, r]));
  const cod = byKey(coding.body), ag = byKey(agentic.body);
  const models = {};
  for (const m of feed.body.items || []) {
    models[m.modelKey] = {
      name: m.name, creator: m.creator, url: m.url, releaseDate: m.releaseDate || null,
      price: m.price ? { input: m.price.input ?? null, output: m.price.output ?? null, unit: m.price.unit || 'per-1m-tokens', confirmed: m.price.lastConfirmedAt || null } : null,
      overall: m.overall ? { score: m.overall.score ?? null, rank: m.overall.rank ?? null } : null,
      coding: pick(cod[m.modelKey]), agentic: pick(ag[m.modelKey]),
      supersededBy: m.supersededBy || [],
    };
  }
  const out = {
    at: Date.now(), dataAsOf: feed.body.dataAsOf || null, pricesAsOf: feed.body.pricesAsOf || null,
    attribution: feed.body.attribution || ATTRIBUTION, policyUrl: feed.body.policyUrl || 'https://benchlm.ai/terms#data-access',
    readsLeft: Number.isFinite(agentic.remaining) ? agentic.remaining : null, models,
  };
  writeJSON(CACHE, out);
  return out;
}

// Stats for one of our model ids or families, or null.
export const statsFor = (idOrFamily, c = cached()) => benchFor(c, idOrFamily);
