// First-run setup on a "fresh machine": empty $HOME, codex only (fake), no agy.
// Run: node --test tests/setup.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = fs.realpathSync(path.join(here, '../cli/agent-handoff'));
const FAKE = path.join(here, 'fixtures/fake-codex.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOMEDIR = path.join(tmp, 'user');
const BIN = path.join(HOMEDIR, '.local', 'bin');
const tools = path.join(tmp, 'tools'); // codex lives here, like a global npm bin
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(tools, { recursive: true });
fs.symlinkSync(FAKE, path.join(tools, 'codex'));
fs.chmodSync(FAKE, 0o755);
const PATHV = [BIN, tools, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
const env = (extra = {}) => ({ PATH: PATHV, HOME: HOMEDIR, SHELL: '/bin/zsh', AGY_BIN: path.join(tmp, 'no-agy'), ...extra });
const run = (cmd, args, extra) => spawnSync(cmd, args, { encoding: 'utf8', env: env(extra), timeout: 60e3 });

test('setup installs a launcher on PATH, readies the pane, and doctor is green', () => {
  const s = run(process.execPath, [CLI, 'setup']);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`✓ launcher ${BIN}/agent-handoff`));
  assert.match(s.stdout, /· agy: not installed/);
  assert.match(s.stdout, /✓ codex codex-cli 0\.0\.0-fake: signed in, 6\/6 ladder models/);
  assert.match(s.stdout, /✓ agent-handoff on PATH/);
  const rt = JSON.parse(fs.readFileSync(path.join(HOMEDIR, '.agent-handoff', 'runtime.json'), 'utf8'));
  assert.equal(rt.cli, CLI);
  // The launcher works by name from a plain shell.
  const d = run('/bin/sh', ['-c', 'agent-handoff doctor']);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  // Running setup again is a no-op that keeps our launcher.
  assert.equal(run(process.execPath, [CLI, 'setup']).status, 0);
});

test('doctor flags a signed-out codex as the only backend', () => {
  const d = run(process.execPath, [CLI, 'doctor'], { FAKE_CODEX_LOGGED_OUT: '1' });
  assert.equal(d.status, 1);
  assert.match(d.stdout, /! codex .*not signed in \(run: codex login\)/);
  assert.match(d.stdout, /✗ no backend ready/);
});

test('the launcher survives a plugin update that moves the plugin folder', async () => {
  const { launcherScript } = await import('../lib/setup.mjs');
  // Old version folder gone; a newer copy sits in the plugin cache.
  const newer = path.join(HOMEDIR, '.claude/plugins/cache/market/agent-handoff/9.9.9/cli');
  fs.mkdirSync(newer, { recursive: true });
  fs.symlinkSync(CLI, path.join(newer, 'agent-handoff'));
  const f = path.join(tmp, 'launcher');
  fs.writeFileSync(f, launcherScript('/gone/0.1.0/cli/agent-handoff', '/gone/node'), { mode: 0o755 });
  const r = run(f, ['config']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /backend\s+auto/);
});

test('setup reuses its own launcher dir and leaves another agent-handoff earlier on PATH alone', () => {
  const other = path.join(tmp, 'other-bin');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'agent-handoff'), '#!/bin/sh\necho not ours\n', { mode: 0o755 });
  const p = [other, PATHV].join(':');
  const s = run(process.execPath, [CLI, 'setup'], { PATH: p });
  // Ours already exists in ~/.local/bin, so setup reuses that dir and leaves the other file alone.
  assert.equal(fs.readFileSync(path.join(other, 'agent-handoff'), 'utf8'), '#!/bin/sh\necho not ours\n');
  assert.match(s.stdout, /✓ launcher/);
});

test('setup removes the launcher the old agy-relay name left behind', () => {
  const old = path.join(BIN, 'agy-relay');
  fs.writeFileSync(old, '#!/bin/sh\n# agy-relay launcher written by `agy-relay setup`\n', { mode: 0o755 });
  const s = run(process.execPath, [CLI, 'setup']);
  assert.match(s.stdout, /removed the old agy-relay launcher/);
  assert.ok(!fs.existsSync(old));
});
