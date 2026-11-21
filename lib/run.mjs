// One worker turn under a watchdog: spawn the backend (agy or codex), turn its
// event stream into relay events, keep status.json current, kill on
// stall/loop/timeout, then check the result against git and the test gate and
// write the ledger.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { getBackend } from './backends/index.mjs';
import { config } from './config.mjs';
import { appendLedger, jobFile, readJSON, writeJSON } from './store.mjs';

const PROPS = {
  status: { type: 'string', enum: ['done', 'question', 'blocked', 'failed'] },
  summary: { type: 'string' },
  question: { type: 'string' },
  files_changed: { type: 'array', items: { type: 'string' } },
  tests_run: { type: 'string' },
  notes: { type: 'string' },
};
export const SCHEMA = { type: 'object', required: ['status', 'summary'], properties: PROPS };
// Codex's structured output wants every property required and no extras;
// unused fields come back as "" or [].
export const STRICT_SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(PROPS), properties: PROPS };

export function brief({ task, dir, write }) {
  return [
    'You are a worker for Claude, who orchestrates and will check your work.',
    `Workspace: ${dir}`,
    write
      ? `Write files only by absolute path inside ${dir}. Do not git commit, push, or change branches.`
      : 'This is a read-only task: do not create or change any file.',
    'Rules:',
    '- Never edit installed packages, lockfiles, test fixtures or mocks to make a check pass. Report the failure instead.',
    `- Read only inside ${dir} unless the task names another path. Do not inspect the relay (agent-handoff), its job files or your own logs.`,
    '- If the task leaves a decision open that you cannot settle from the files, stop and return status "question" with ONE specific question. Do not guess.',
    '- If an answer from Claude is unclear or does not fit your question, return status "question" again and say why; do not go looking for its meaning.',
    '- If something stops you (missing file, permission, broken environment), return status "blocked" and say exactly what.',
    '- When finished, return status "done": summary under 120 words of facts (file:line where it helps), files_changed as absolute paths, tests_run with the command and result if you ran any.',
    '',
    'TASK:',
    task,
  ].join('\n');
}

const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 30e3 });

function gitSnapshot(dir) {
  const head = sh('git', ['rev-parse', 'HEAD'], dir);
  if (head.status !== 0) return null;
  const st = sh('git', ['status', '--porcelain', '--untracked-files=all'], dir);
  return { head: head.stdout.trim(), lines: new Set(st.stdout.split('\n').filter(Boolean)) };
}

// agy print output has carried a truncated first copy before the full one
// (wiki mb4130e8), so take the LAST parseable object that has a status.
export function parseStatus(text) {
  const t = String(text || '').trim();
  for (let i = t.lastIndexOf('{'); i >= 0; i = t.lastIndexOf('{', i - 1)) {
    try {
      const o = JSON.parse(t.slice(i));
      if (o && typeof o.status === 'string') return o;
    } catch { /* keep scanning */ }
    if (i === 0) break;
  }
  return null;
}

// "**Planning the export**\n\nI'll start by…" -> "Planning the export"
export const headline = (text) => {
  const t = String(text || '').trim();
  const bold = t.match(/^\*\*(.+?)\*\*/);
  return (bold ? bold[1] : t.split('\n')[0]).replace(/[*_`#]/g, '').trim().slice(0, 120);
};

const SUSPICIOUS = /(^|\/)(node_modules|site-packages|\.venv|venv|vendor|dist-packages)\//;

export async function runTurn(id, prompt, { conversation, answer } = {}) {
  const meta = readJSON(jobFile(id, 'meta.json'));
  meta.backend ||= 'agy';
  const be = getBackend(meta.backend);
  const W = be.label;
  const t0 = Date.now();
  const clock = () => { const s = Math.round((Date.now() - t0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const logStream = fs.createWriteStream(jobFile(id, 'log.txt'), { flags: 'a' });
  const say = (msg) => { const line = `[${clock()}] ${msg}`; console.log(line); logStream.write(line + '\n'); };
  // Timestamped events for the dashboard (agy's own stream carries no times).
  const evStream = fs.createWriteStream(jobFile(id, 'events.jsonl'), { flags: 'a' });
  const turnNo = (meta.turns || 0) + 1; // fixed now: finalize bumps meta.turns before the last event
  const emit = (o) => evStream.write(JSON.stringify({ ts: new Date().toISOString(), turn: turnNo, ...o }) + '\n');

  const before = gitSnapshot(meta.dir);
  const schemaPath = jobFile(id, 'schema.json');
  writeJSON(schemaPath, meta.backend === 'codex' ? STRICT_SCHEMA : SCHEMA);
  const lastPath = jobFile(id, 'last-message.txt');
  try { fs.rmSync(lastPath, { force: true }); } catch { /* none */ }

  const { bin, args } = be.command(meta, prompt, { conversation, schemaPath, lastPath });
  // stdin must be closed: codex exec otherwise waits on "Reading additional input from stdin".
  const child = spawn(bin, args, { cwd: meta.dir, env: be.childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = fs.createWriteStream(jobFile(id, 'stream.ndjson'), { flags: 'a' });
  const errOut = fs.createWriteStream(jobFile(id, 'stderr.txt'), { flags: 'a' });
  child.stderr.pipe(errOut);

  const st = {
    id, state: 'starting', backend: meta.backend, model: meta.model, kind: meta.kind, pid: process.pid, agy_pid: child.pid,
    turn: (meta.turns || 0) + 1, conversation_id: conversation || meta.conversation_id || null,
    started: new Date().toISOString(), last_event_at: new Date().toISOString(),
    steps: 0, tool_calls: 0, tool_errors: 0, hook_denials: 0, active: null, warning: null, tokens: 0,
  };
  let lastEvent = Date.now(), lastWrite = 0, killedFor = null, result = null, text = '', limited = null;
  let sig = null, repeats = 0;
  const warns = [];
  // Files the worker's own file tools wrote, so other edits made during the run
  // (another session, the user) aren't credited to it.
  const agyFiles = new Set(meta.agy_files || []);
  const save =(force) => { if (force || Date.now() - lastWrite > 1000) { lastWrite = Date.now(); writeJSON(jobFile(id, 'status.json'), st); } };

  const kill = (why) => {
    if (killedFor) return;
    killedFor = why;
    say(`KILL: ${why}`);
    emit({ type: 'kill', reason: why, active: st.active });
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  };
  const onSignal = () => kill('cancelled');
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  say(`${conversation ? 'resume' : 'start'} ${id} backend=${meta.backend} model=${meta.model} kind=${meta.kind} ${meta.write ? 'write' : 'read-only'} dir=${meta.dir}`);
  emit({ type: 'handoff', role: 'claude', mode: conversation ? 'answer' : 'brief', text: conversation ? (answer || prompt) : meta.task, backend: meta.backend, model: meta.model, kind: meta.kind, write: meta.write, reasons: meta.route_reasons });
  save(true);

  const parse = be.parser(meta);
  const handle = (e) => {
    switch (e.k) {
      case 'pickup':
        st.conversation_id = e.id;
        st.state = 'working';
        say(`${W} picked up the task, conversation ${e.id}`);
        emit({ type: 'pickup', backend: meta.backend, conversation_id: e.id });
        break;
      case 'steps': st.steps = Math.max(st.steps, e.n); break;
      case 'tokens': st.tokens += e.n; break;
      case 'text': text = (e.replace ? e.t : text + e.t).slice(-4000); break;
      case 'tool_start':
        st.state = 'working';
        st.active = { tool: e.tool, arg: e.arg, since: st.last_event_at };
        say(`tool ${e.tool} ${e.arg}`);
        emit({ type: 'tool', state: 'start', step: e.step, tool: e.tool, arg: e.arg });
        break;
      case 'tool_end':
        st.active = null;
        st.tool_calls++;
        st.steps = Math.max(st.steps, st.tool_calls);
        repeats = e.sig === sig ? repeats + 1 : 1;
        sig = e.sig;
        emit({ type: 'tool', state: e.ok ? 'done' : 'error', step: e.step, tool: e.tool, arg: e.arg, dur: e.dur, msg: (e.msg || '').slice(0, 300) || undefined, hook: e.hook || undefined });
        for (const f of e.files || []) agyFiles.add(String(f).split(`${meta.dir}/`).join(''));
        if (!e.ok) {
          st.tool_errors++;
          if (e.hook) st.hook_denials++;
          say(`tool ERROR ${e.tool}: ${(e.msg || '').slice(0, 140)}`);
        }
        if (repeats >= 3) st.warning = `looping: ${e.tool} called ${repeats}x with the same arguments`;
        if (repeats >= 5) kill('looping');
        break;
      case 'busy': if (!st.active) st.active = { tool: e.what, arg: '', since: st.last_event_at }; break;
      case 'idle': if (st.active?.tool === e.what) st.active = null; break;
      case 'warn': if (e.msg && warns.length < 5) { warns.push(String(e.msg).slice(0, 200)); say(`${W} warning: ${String(e.msg).slice(0, 140)}`); } break;
      case 'thought': {
        // The worker's reasoning summary: keep the headline in status for the band and
        // NOW line, and the text in the timeline.
        const text = String(e.t).trim().slice(0, 1500);
        const head = headline(text);
        st.thought = { head, at: new Date().toISOString() };
        say(`${W} thinking: ${head}`);
        emit({ type: 'thought', backend: meta.backend, text });
        break;
      }
      case 'limit': limited = e.msg; say(`${W} usage limit: ${String(e.msg).slice(0, 160)}`); break;
      case 'result': result = e; break;
      default: break;
    }
  };

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    raw.write(line + '\n');
    let ev; try { ev = JSON.parse(line); } catch { return; }
    lastEvent = Date.now();
    st.last_event_at = new Date().toISOString();
    for (const e of parse(ev)) handle(e);
    save();
  });

  let lastBeat = Date.now();
  const timer = setInterval(() => {
    const idle = (Date.now() - lastEvent) / 1000;
    const longTool = be.LONG_TOOL.test(st.active?.tool || '') ? 2 : 1;
    if (st.state === 'starting' && idle > meta.startup_s) kill('stalled_startup');
    else if (idle > meta.stall_s * longTool) kill('stalled');
    else if ((Date.now() - t0) / 1000 > meta.timeout_s + 60) kill('timeout');
    st.idle_s = Math.round(idle);
    if (Date.now() - lastBeat > 60e3) {
      lastBeat = Date.now();
      say(`still ${st.state}: ${st.steps} steps, ${st.tool_calls} tools, ${st.tool_errors} errors, idle ${Math.round(idle)}s${st.active ? `, in ${st.active.tool}` : ''}`);
    }
    save(true);
  }, 5000);

  const code = await new Promise((res) => child.on('close', res));
  clearInterval(timer);
  rl.close();
  await new Promise((res) => raw.end(res));
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);

  // codex -o writes the final message to a file; prefer it when the stream's copy is missing.
  if (result && !result.response) { try { result.response = fs.readFileSync(lastPath, 'utf8'); } catch { /* none */ } }

  const state = finalize({ id, meta, be, st, result, text, killedFor, limited, warns, code, before, t0, say, logStream, emit, agyFiles });
  await new Promise((res) => evStream.end(res));
  return state;
}

function finalize({ id, meta, be, st, result, text, killedFor, limited, warns, code, before, t0, say, logStream, emit, agyFiles }) {
  const W = be.label;
  const parsed = parseStatus(result?.response ?? text);
  let state;
  if (killedFor) state = killedFor;
  else if (limited) state = 'limited';
  else if (!result) state = 'failed';
  else if (!result.ok) state = 'failed';
  else state = parsed?.status || 'done';

  const report = { summary: parsed?.summary || String(result?.error || result?.response || text).trim().slice(-600), question: parsed?.question || undefined, warnings: [] };
  if (result?.ok && !parsed) report.warnings.push(`${W} did not return the JSON status object; summary is its raw reply tail`);
  if (code && !killedFor && result?.ok) report.warnings.push(`${W} exited ${code} after a successful result`);
  if (st.hook_denials) report.warnings.push(`${st.hook_denials} tool calls denied by a hook (${be.hookHint})`);
  if (st.warning) report.warnings.push(st.warning);
  for (const w of warns) report.warnings.push(`${W}: ${w}`);

  // What actually changed, from git rather than agy's claim.
  let changed = [], others = [];
  const after = before && gitSnapshot(meta.dir);
  if (after) {
    const all = [...after.lines].filter((l) => !before.lines.has(l));
    const byAgy = (l) => {
      const p = l.slice(3).replace(/^"|"$/g, '');
      for (const f of agyFiles) if (p === f || p.endsWith(`/${f}`) || f.endsWith(`/${p}`)) return true;
      return false;
    };
    changed = all.filter(byAgy);
    others = all.filter((l) => !byAgy(l));
    if (others.length) report.warnings.push(`${others.length} other file(s) changed during the run, not by ${W}'s file tools (another session, you, or ${W}'s shell):${others.slice(0, 5).map((l) => l.slice(3)).join(', ')}${others.length > 5 ? ' …' : ''}`);
    if (after.head !== before.head) report.warnings.push(`HEAD moved ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)} during the run`);
    if (!meta.write && all.length) report.warnings.push('files changed during a read-only run');
    const bad = all.filter((l) => SUSPICIOUS.test(l.slice(3)));
    if (bad.length) report.warnings.push(`changes in dependency dirs (possible environment tampering): ${bad.slice(0, 5).join(', ')}`);
    // Keep agy's diff so `review` shows it even after the repo moves on.
    if (changed.length) {
      const paths = changed.filter((l) => !l.startsWith('??')).map((l) => l.slice(3));
      // Porcelain paths are relative to the repo root, which may sit above meta.dir.
      const top = sh('git', ['rev-parse', '--show-toplevel'], meta.dir).stdout.trim() || meta.dir;
      const d = paths.length ? spawnSync('git', ['-C', top, 'diff', 'HEAD', '--', ...paths], { encoding: 'utf8', timeout: 20e3 }).stdout || '' : '';
      const added = changed.filter((l) => l.startsWith('??')).map((l) => {
        const f = l.slice(3);
        try { return `--- new file ${f}\n${fs.readFileSync(`${top}/${f}`, 'utf8')}`; } catch { return `--- new file ${f} (unreadable)`; }
      });
      fs.writeFileSync(jobFile(id, 'diff.patch'), [d, ...added].join('\n'));
    }
    const claimed = (parsed?.files_changed || []).map((f) => f.replace(`${meta.dir}/`, ''));
    const missing = claimed.filter((f) => !changed.some((l) => l.endsWith(f)));
    if (missing.length) report.warnings.push(`claimed but not changed per git: ${missing.slice(0, 5).join(', ')}`);
  }

  // role stays 'agy' (= the worker) so older pane code keeps working; backend names it.
  emit({ type: 'reply', role: 'agy', backend: meta.backend, state, summary: report.summary, question: report.question, warnings: report.warnings,
    changed, claimed: parsed?.files_changed, tests_run: parsed?.tests_run, notes: parsed?.notes, unstructured: !!result && !parsed });

  // The gate is ours to run; agy's "tests pass" is never taken on trust.
  let tests_pass = null, testsTail = '';
  if (meta.tests && state === 'done') {
    say(`running gate: ${meta.tests}`);
    const r = spawnSync('sh', ['-c', meta.tests], { cwd: meta.dir, encoding: 'utf8', timeout: 15 * 60e3, env: process.env });
    tests_pass = r.status === 0;
    testsTail = `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-25).join('\n');
    fs.writeFileSync(jobFile(id, 'tests.txt'), testsTail);
    emit({ type: 'gate', cmd: meta.tests, pass: tests_pass, tail: testsTail });
    if (!tests_pass) state = 'tests_failed';
  }

  const usage = result?.usage || {};
  const totals = meta.totals || { duration_s: 0, tokens: 0, questions: 0, stalls: 0 };
  totals.duration_s += Math.round((Date.now() - t0) / 1000);
  totals.tokens += usage.total || st.tokens;
  if (state === 'question') totals.questions++;
  if (/stalled|looping|timeout/.test(state)) totals.stalls++;

  Object.assign(meta, { turns: st.turn, conversation_id: st.conversation_id, totals, last_state: state, agy_files: [...agyFiles] });
  writeJSON(jobFile(id, 'meta.json'), meta);
  Object.assign(st, { state, active: null, finished: new Date().toISOString(), ...report, changed, other_changes: others, tests_pass });
  writeJSON(jobFile(id, 'status.json'), st);

  appendLedger({
    type: 'run', id, backend: meta.backend, kind: meta.kind, model: meta.model, write: meta.write, state, turns: st.turn,
    duration_s: totals.duration_s, tokens: { total: totals.tokens, input: usage.input, output: usage.output, thinking: usage.thinking, cached: usage.cached },
    steps: st.steps, tool_calls: st.tool_calls, tool_errors: st.tool_errors, hook_denials: st.hook_denials,
    questions: totals.questions, stalls: totals.stalls, files_changed: changed.length, tests_pass, route: meta.route_reasons,
  });
  emit({ type: 'final', state, duration_s: totals.duration_s, tokens: totals.tokens });

  const lines = [
    '',
    `=== agent-handoff ${id} · ${state} · ${meta.backend} ${meta.model} · ${totals.duration_s}s · ${Math.round(totals.tokens / 1000)}k tok · turn ${st.turn}`,
    `summary: ${report.summary}`,
  ];
  if (report.question) lines.push(`QUESTION: ${report.question}`);
  if (changed.length) lines.push(`changed (git): ${changed.slice(0, 15).join(', ')}${changed.length > 15 ? ` +${changed.length - 15}` : ''}`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  if (tests_pass !== null) lines.push(`gate: ${tests_pass ? 'PASS' : 'FAIL'}${tests_pass ? '' : `\n${testsTail}`}`);
  const next = {
    question: `answer it: agent-handoff answer ${id} "<answer>"`,
    blocked: `fix the blocker, then: agent-handoff answer ${id} "<what changed>"`,
    stalled: `nudge: agent-handoff answer ${id} "Report your status and finish."  (or cancel and do it yourself)`,
    looping: `redirect: agent-handoff answer ${id} "<different approach>"`,
    stalled_startup: `${W} never started${meta.backend === 'agy' ? ' (often "Fetching available models" hang)' : ''}: retry once, then do it without ${W}`,
    limited: `${W} hit its usage limit; the router skips it until the reset. Rerun with --backend ${meta.backend === 'codex' ? 'agy' : 'codex'} or later`,
  }[state] || (config().autobench
    ? `agent-handoff review ${id}, then: agent-handoff verify ${id} pass|partial|fail --note "<why>"`
    : `agent-handoff review ${id} (auto-benchmarking off: no verdict needed)`);
  lines.push(`next: ${next}`);
  const out = lines.join('\n');
  console.log(out);
  logStream.end(out + '\n');
  return state;
}

export const EXIT = { done: 0, question: 10, blocked: 11, stalled: 12, looping: 12, timeout: 12, stalled_startup: 12, failed: 13, tests_failed: 14, cancelled: 15, limited: 16 };
