// `setup` makes the CLI callable as `agy-relay` and readies the data folder;
// `doctor` checks node, each backend, PATH and the pane. Both print a checklist.
//
// setup writes a small launcher script rather than a symlink: a plugin update
// installs to a new versioned folder (plugins/cache/<market>/<plugin>/<version>),
// which would leave a symlink dangling. The launcher finds the newest copy.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, writeJSON } from './store.mjs';
import { BACKENDS, ORDER } from './backends/index.mjs';
import { config } from './config.mjs';

export const NAME = 'agy-relay';
export const CLI = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../cli', NAME));
const MARK = '# agy-relay launcher written by `agy-relay setup`';
const home = os.homedir();
const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 30e3, stdio: ['ignore', 'pipe', 'pipe'] });
const pathDirs = () => (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };

export function launcherScript(cli = CLI, node = process.execPath) {
  return `#!/bin/sh
${MARK}
CLI="${cli}"
NODE="${node}"
if [ ! -f "$CLI" ]; then
  CLI=$(ls -td "$HOME"/.claude/plugins/cache/*/${NAME}/*/cli/${NAME} "$HOME"/.claude/skills/${NAME}/cli/${NAME} 2>/dev/null | head -n 1)
fi
[ -x "$NODE" ] || NODE=$(command -v node)
if [ -z "$CLI" ] || [ -z "$NODE" ]; then
  echo "${NAME}: cannot find the plugin or node; reinstall the plugin, then run its cli/${NAME} setup" >&2
  exit 127
fi
exec "$NODE" "$CLI" "$@"
`;
}

// Where the launcher goes: an existing one of ours, else the first writable PATH
// dir under $HOME, else ~/.local/bin (created; may need adding to PATH).
function pickBinDir() {
  for (const d of pathDirs()) {
    const f = path.join(d, NAME);
    if (fs.existsSync(f) && isOurs(f)) return d;
  }
  const inHome = pathDirs().find((d) => d.startsWith(home) && fs.existsSync(d) && writable(d) && /\/(\.local\/bin|bin)$/.test(d));
  return inHome || path.join(home, '.local', 'bin');
}

function isOurs(f) {
  try {
    if (fs.lstatSync(f).isSymbolicLink()) return /agy-relay/.test(fs.readlinkSync(f));
    return fs.readFileSync(f, 'utf8').includes(MARK);
  } catch { return false; }
}

export function setup({ force = false, binDir } = {}) {
  const lines = [];
  const dir = binDir || pickBinDir();
  const target = path.join(dir, NAME);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(target) && !isOurs(target) && !force) {
    lines.push(`✗ ${target} exists and is not ours; rerun with --force to replace it`);
  } else {
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, launcherScript(), { mode: 0o755 });
    lines.push(`✓ launcher ${target} -> ${CLI}`);
  }
  if (!pathDirs().includes(dir)) {
    const rc = /zsh/.test(process.env.SHELL || '') ? '~/.zshrc' : '~/.bashrc';
    lines.push(`! ${dir} is not on PATH. Add it once: echo 'export PATH="${dir}:$PATH"' >> ${rc}`);
  }
  fs.mkdirSync(HOME, { recursive: true });
  // The pane runs the CLI through these (the Desktop app's PATH may lack node).
  writeJSON(path.join(HOME, 'runtime.json'), { node: process.execPath, cli: CLI });
  lines.push(`✓ data folder ${HOME}`);
  for (const b of ORDER) { try { BACKENDS[b].listModels({ refresh: true }); } catch { /* doctor reports it */ } }
  return { lines, ok: !lines.some((l) => l.startsWith('✗')) };
}

export function doctor() {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(major >= 18 ? `✓ node ${process.versions.node}` : `✗ node ${process.versions.node}: need 18 or newer`);

  let ready = 0;
  for (const b of ORDER) {
    const be = BACKENDS[b];
    if (!be.installed()) {
      lines.push(`· ${b}: not installed${b === 'agy' ? ' (install the Antigravity CLI, `agy`, to use Gemini)' : ' (npm install -g @openai/codex to use GPT)'}`);
      continue;
    }
    const ver = spawnSync(be.BIN, ['--version'], { encoding: 'utf8', timeout: 15e3 }).stdout.trim().split('\n')[0];
    let signed;
    if (b === 'codex') signed = spawnSync(be.BIN, ['login', 'status'], { encoding: 'utf8', timeout: 15e3, stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;
    else signed = be.listModels().length > 0;
    const ladder = be.listModels().map((m) => m.id);
    const onLadder = be.LADDER.filter((m) => ladder.includes(m)).length;
    // '!' not '✗': one backend down is fine while the other is ready (checked below).
    if (!signed) lines.push(`! ${b} ${ver} at ${be.BIN}: not signed in (${b === 'codex' ? 'run: codex login' : 'open agy once and sign in'})`);
    else if (!onLadder) lines.push(`! ${b} ${ver}: signed in, but none of its ladder models are offered (agy-relay models)`);
    else { ready++; lines.push(`✓ ${b} ${ver}: signed in, ${onLadder}/${be.LADDER.length} ladder models${be.blocked() ? `; ${be.blocked()}` : ''}`); }
  }
  if (!ready) lines.push('✗ no backend ready: install and sign in to agy or codex');

  const found = sh(`command -v ${NAME}`).stdout.trim();
  lines.push(found ? `✓ ${NAME} on PATH (${found})` : `✗ ${NAME} is not on PATH: run node "${CLI}" setup`);
  lines.push(fs.existsSync(path.join(HOME, 'runtime.json')) ? '✓ pane can run the CLI' : `✗ pane cannot run the CLI yet: run ${NAME} setup`);
  const c = config();
  lines.push(`· config: backend ${c.backend}, bench ${c.bench ? 'on' : 'off'}`);
  return { lines, ok: !lines.some((l) => l.startsWith('✗')) };
}
