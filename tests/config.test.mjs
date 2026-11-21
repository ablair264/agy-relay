// The auto-benchmarking switch, config written before the rename, and the
// one-time move of ~/.agy-relay to ~/.agent-handoff.
// Run: node --test tests/config.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../cli/agent-handoff');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-config-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 30e3 });

test('autobench switches on, off and toggles, and route follows it', () => {
  const HOME = path.join(tmp, 'a');
  const env = { AGENT_HANDOFF_HOME: HOME, HOME: tmp };
  assert.match(run(['autobench'], env).stdout, /autobench on: Claude reviews and rates/);
  assert.match(run(['autobench', 'off'], env).stdout, /autobench off/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).autobench, false);
  assert.match(run(['config', 'autobench', 'toggle'], env).stdout, /autobench on/);
  assert.match(run(['autobench', 'off'], { ...env, AGENT_HANDOFF_AUTOBENCH: '1' }).stdout, /autobench on/, 'the env var overrides for one shell');
  assert.notEqual(run(['autobench', 'maybe'], env).status, 0);
});

test('a config.json from before the rename keeps its bench setting', () => {
  const HOME = path.join(tmp, 'b');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ backend: 'codex', bench: false }));
  const out = run(['config'], { AGENT_HANDOFF_HOME: HOME, HOME: tmp }).stdout;
  assert.match(out, /backend\s+codex/);
  assert.match(out, /autobench off/);
});

test('data in ~/.agy-relay moves to ~/.agent-handoff on first use', () => {
  const H = path.join(tmp, 'user');
  fs.mkdirSync(path.join(H, '.agy-relay', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(H, '.agy-relay', 'ledger.jsonl'), '');
  const r = run(['config'], { HOME: H });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(H, '.agent-handoff', 'ledger.jsonl')));
  assert.ok(!fs.existsSync(path.join(H, '.agy-relay')));
});

test('worker, model and limit settings round-trip, and bad values are refused', () => {
  const HOME = path.join(tmp, 'c');
  const env = { CLAUDE_X: '1', AGENT_HANDOFF_HOME: HOME, HOME: tmp };
  run(['config', 'worker', 'agy', 'off'], env);
  run(['config', 'model', 'gpt-6-luna:low', 'off'], env);
  run(['config', 'limit', 'low', '30'], env);
  const out = run(['config', 'limit', 'stop', '10%'], env).stdout;
  assert.match(out, /workers\s+agy off, codex on/);
  assert.match(out, /prefer the other worker below 30% left · never use a worker below 10% left/);
  assert.match(out, /✗ gpt-6-luna:low/);
  const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  assert.deepEqual([c.workers.agy, c.disabled_models, c.limits], [false, ['gpt-6-luna:low'], { low: 0.3, stop: 0.1 }]);
  run(['config', 'model', 'gpt-6-luna:low', 'toggle'], env);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).disabled_models, []);
  for (const bad of [['worker', 'claude', 'off'], ['model', 'llama-9', 'off'], ['limit', 'low', '140'], ['limit', 'soft', '5']]) {
    assert.notEqual(run(['config', ...bad], env).status, 0, bad.join(' '));
  }
});

test("the pane's model lists match the backends", async () => {
  const { MODELS } = await import('../lib/backends/index.mjs');
  const data = await import('../hooks/data.js');
  assert.deepEqual(data.MODELS, MODELS);
});

test('your own ladder and dismissed models are stored and validated', () => {
  const HOME = path.join(tmp, 'd');
  const env = { AGENT_HANDOFF_HOME: HOME, HOME: tmp };
  const out = run(['config', 'ladder', 'codex', 'gpt-6-luna:low,gpt-6.3-sol:low', 'gpt-6.3-sol:high'], env).stdout;
  assert.match(out, /codex models \(your own ladder/);
  assert.match(out, /✓ gpt-6\.3-sol:high/);
  assert.notEqual(run(['config', 'ladder', 'codex', 'gpt-6.3-sol'], env).status, 0, 'codex ids need an effort');
  assert.notEqual(run(['config', 'ladder', 'agy', 'gpt-6-luna:low'], env).status, 0, 'not an agy model');
  run(['config', 'ignore', 'gpt-7-nova'], env);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).ignored_models, ['gpt-7-nova']);
  run(['config', 'ladder', 'codex', 'default'], env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).ladders.codex, undefined);
});
