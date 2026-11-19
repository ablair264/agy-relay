// `agy-relay review <id>`: everything Claude needs to judge a finished job,
// in one compact packet, so the verdict is quick and consistent.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { jobFile, readJSON, readLedger } from './store.mjs';

const MAX_DIFF_LINES = 220;
const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 20e3 });
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function diffOf(dir, changed) {
  if (!changed?.length) return 'no file changes recorded';
  const tracked = git(dir, ['diff', '--stat', 'HEAD']).stdout.trim();
  const body = git(dir, ['diff', 'HEAD']).stdout;
  const parts = [tracked, body];
  for (const line of changed.filter((l) => l.startsWith('??'))) {
    const f = line.slice(3);
    const text = read(`${dir}/${f}`);
    parts.push(`--- new file ${f} (${text.split('\n').length} lines)\n${text}`);
  }
  const lines = parts.join('\n').split('\n');
  return lines.length > MAX_DIFF_LINES
    ? `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n… ${lines.length - MAX_DIFF_LINES} more lines: git -C ${dir} diff HEAD`
    : lines.join('\n');
}

export function reviewPacket(id) {
  const meta = readJSON(jobFile(id, 'meta.json'), {});
  const st = readJSON(jobFile(id, 'status.json'), {});
  const prior = readLedger().find((r) => r.id === id);
  const task = (read(jobFile(id, 'task.md')).split('\nTASK:\n')[1] || meta.task || '').trim();
  const out = [
    `=== review ${id} · ${st.state} · ${meta.model} · ${meta.kind}${meta.write ? ' write' : ''} · ${meta.turns || 1} turn(s) · ${meta.totals?.duration_s ?? '-'}s · ${Math.round((meta.totals?.tokens || 0) / 1000)}k tok`,
    `dir: ${meta.dir}`,
    `task: ${task}`,
    `agy says: ${st.summary || '-'}`,
  ];
  if (st.question) out.push(`open question: ${st.question}`);
  for (const w of st.warnings || []) out.push(`warning: ${w}`);
  if (meta.tests) {
    const tail = read(jobFile(id, 'tests.txt')).trim().split('\n').slice(-12).join('\n');
    out.push(`gate (${meta.tests}): ${st.tests_pass === true ? 'PASS' : st.tests_pass === false ? 'FAIL' : 'not run'}${tail ? `\n${tail}` : ''}`);
  }
  out.push(`changed by agy (git): ${(st.changed || []).map((l) => l.trim()).join(', ') || 'nothing'}`);
  if (st.other_changes?.length) out.push(`also changed during the run, not by agy's file tools: ${st.other_changes.map((l) => l.trim()).join(', ')}`);
  if (meta.write && meta.dir) {
    const saved = read(jobFile(id, 'diff.patch'));
    const lines = saved.split('\n');
    out.push('', saved
      ? (lines.length > MAX_DIFF_LINES ? `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n… ${lines.length - MAX_DIFF_LINES} more lines in ${jobFile(id, 'diff.patch')}` : saved)
      : `(no saved diff; showing the repo as it is now)\n${diffOf(meta.dir, st.changed)}`);
  }
  out.push('', prior?.verdict
    ? `verdict already recorded: ${prior.verdict}${prior.verdict_note ? ` (${prior.verdict_note})` : ''}`
    : `no verdict yet. Record one: agy-relay verify ${id} pass|partial|fail --note "<why>"
  pass = right and usable as is · partial = worked but you had to fix or finish it · fail = wrong, unusable, or it gamed the gate`);
  return out.join('\n');
}
