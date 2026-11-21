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
