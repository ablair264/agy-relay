// `agent-handoff demo`: realistic sample handoffs for screenshots and screen
// recordings of the /handoff pane, with no worker, no model turns and no tokens.
//
// It writes a separate data folder (default ~/.agent-handoff-demo, never your real
// one), then keeps the jobs moving until Ctrl+C:
//   - a Codex job implementing a CSV export: tool calls stream in, the test gate
//     passes, then Claude's rating lands
//   - an agy job tracing time-zone handling, mid-run, finishing a little later
//   - an agy job waiting on a question (answer it from the pane and it carries on)
//   - six finished jobs for the Jobs tab, a ledger that fills the Bench tab, and
//     usage meters
// Stop, Change model and Answer work: the CLI sees `demo: true` in a job's meta and
// leaves a request file that this process acts on. Every `--cycle` seconds
// (default 150) the scene starts over, so a recording can be retaken.
//
// Point Claude Code at the folder:  AGENT_HANDOFF_HOME=~/.agent-handoff-demo claude
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../cli/agent-handoff'));
const PROJECT = '/home/dev/acme-dashboard';
const tick = 400;

const writeJSON = (f, d) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(d, null, 2)); fs.renameSync(t, f); };
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const iso = (ms) => new Date(ms).toISOString();
const stamp = (ms) => iso(ms).slice(5, 16).replace(/[-:T]/g, '');

// Small deterministic random numbers, so every run of the demo looks the same.
function rng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------
// One job on disk: meta.json, task.md, status.json, events.jsonl.

class Job {
  constructor(home, id, meta, brief) {
    this.home = home; this.id = id; this.dir = path.join(home, 'jobs', id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.meta = { id, demo: true, dir: PROJECT, stall_s: meta.backend === 'codex' ? 480 : 240, startup_s: 90, timeout_s: 1800, sandbox: true, ...meta, task: meta.task.slice(0, 300) };
    this.st = { id, backend: meta.backend, model: meta.model, kind: meta.kind, pid: process.pid, turn: 1, steps: 0, tool_calls: 0, tool_errors: 0, hook_denials: 0, active: null, warning: null, tokens: 0 };
    this.turn = 1;
    this.script = [];
    this.t0 = Date.now();
    fs.writeFileSync(path.join(this.dir, 'task.md'), `You are a worker for Claude.\nWorkspace: ${PROJECT}\n\nTASK:\n${brief || meta.task}`);
    fs.writeFileSync(path.join(this.dir, 'events.jsonl'), '');
    fs.writeFileSync(path.join(this.dir, 'log.txt'), '');
    this.saveMeta();
  }
  saveMeta() { writeJSON(path.join(this.dir, 'meta.json'), this.meta); }
  set(patch) { Object.assign(this.st, patch); writeJSON(path.join(this.dir, 'status.json'), this.st); }
  ev(o, at = Date.now()) {
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify({ ts: iso(at), turn: this.turn, ...o }) + '\n');
    this.st.last_event_at = iso(at);
  }
  // Queue steps: [seconds after now, fn]. Replaces whatever was left.
  run(steps) { this.t0 = Date.now(); this.script = steps.map(([t, fn]) => ({ t, fn })); }
  step(now) {
    while (this.script.length && (now - this.t0) / 1000 >= this.script[0].t) this.script.shift().fn(now);
  }
  get running() { return /^(starting|working)$/.test(this.st.state); }
}

// ---------------------------------------------------------------------------
// Building blocks for a job's story. Each returns script steps or writes history.

function brief(job, at) {
  job.ev({ type: 'handoff', role: 'claude', mode: 'brief', text: job.meta.task, backend: job.meta.backend, model: job.meta.model, kind: job.meta.kind, write: job.meta.write, reasons: job.meta.route_reasons }, at);
  job.set({ state: 'starting', started: iso(at), finished: undefined, summary: undefined, question: undefined });
}
function pickup(job, at) {
  const conv = job.meta.conversation_id || `${job.meta.backend === 'codex' ? 'thread' : 'conv'}-${job.id.slice(-4)}`;
  job.meta.conversation_id = conv; job.saveMeta();
  job.ev({ type: 'pickup', backend: job.meta.backend, conversation_id: conv }, at);
  job.set({ state: 'working', conversation_id: conv });
}
// A reasoning summary, as Codex sends them: shown on the THINK line and in the timeline.
function thought(job, text, at) {
  const bold = text.match(/^\*\*(.+?)\*\*/);
  job.ev({ type: 'thought', backend: job.meta.backend, text }, at);
  job.set({ thought: { head: bold ? bold[1] : text.split('\n')[0], at: iso(at) } });
}
function toolStart(job, tool, arg, at) {
  job.ev({ type: 'tool', state: 'start', step: job.st.steps, tool, arg }, at);
  job.set({ state: 'working', active: { tool, arg, since: iso(at) } });
}
function toolDone(job, tool, arg, dur, at, err) {
  job.ev({ type: 'tool', state: err ? 'error' : 'done', step: job.st.steps, tool, arg, dur, msg: err }, at);
  job.set({ active: null, tool_calls: job.st.tool_calls + 1, steps: job.st.steps + 1, tool_errors: job.st.tool_errors + (err ? 1 : 0), tokens: job.st.tokens + 2400 + Math.round(dur * 900) });
}
// Live tool calls from `from` seconds on, `gap` seconds apart.
function toolSteps(job, tools, from, gap = 2.6) {
  const out = [];
  tools.forEach(([tool, arg, dur = 1.2], i) => {
    const t = from + i * gap;
    out.push([t, (now) => toolStart(job, tool, arg, now)]);
    out.push([t + Math.min(dur, gap - 0.3), (now) => toolDone(job, tool, arg, dur, now)]);
  });
  return out;
}
// The same tool calls written straight into history, ending at `end`.
function toolHistory(job, tools, start, gap = 2.6) {
  tools.forEach(([tool, arg, dur = 1.2], i) => {
    const at = start + i * gap * 1000;
    job.ev({ type: 'tool', state: 'start', step: job.st.steps, tool, arg }, at);
    toolDone(job, tool, arg, dur, at + dur * 1000);
  });
}
function finish(job, at, { state = 'done', summary, question, changed = [], gate }) {
  const dur = Math.round((at - Date.parse(job.st.started)) / 1000);
  job.ev({ type: 'reply', role: 'agy', backend: job.meta.backend, state, summary, question, warnings: [], changed, claimed: changed }, at);
  if (changed.length) fs.writeFileSync(path.join(job.dir, 'diff.patch'), fakeDiff(changed));
  let tests_pass = null;
  if (gate && state === 'done') {
    tests_pass = true;
    job.ev({ type: 'gate', cmd: job.meta.tests, pass: true, tail: gate }, at + 1500);
  }
  const tokens = job.st.tokens;
  const totals = { duration_s: (job.meta.totals?.duration_s || 0) + dur, tokens, questions: (job.meta.totals?.questions || 0) + (state === 'question' ? 1 : 0), stalls: 0 };
  job.ev({ type: 'final', state, duration_s: totals.duration_s, tokens }, at + 1600);
  Object.assign(job.meta, { turns: job.turn, totals, last_state: state }); job.saveMeta();
  job.set({ state, active: null, finished: iso(at + 1600), summary, question, changed: changed.map((f) => ` M ${f}`), other_changes: [], warnings: [], tests_pass });
  appendLedger(job.home, { type: 'run', id: job.id, backend: job.meta.backend, kind: job.meta.kind, model: job.meta.model, write: job.meta.write, state, turns: job.turn, duration_s: totals.duration_s, tokens: { total: tokens }, questions: totals.questions, stalls: 0, files_changed: changed.length, tests_pass }, at + 1600);
}
function verdict(job, at, v, note) {
  job.ev({ type: 'verdict', role: 'claude', verdict: v, note }, at);
  appendLedger(job.home, { type: 'verdict', id: job.id, verdict: v, note, by: 'claude' }, at);
}
function stop(job, at) {
  job.script = [];
  job.ev({ type: 'kill', reason: 'cancelled', active: job.st.active }, at);
  job.ev({ type: 'final', state: 'cancelled', duration_s: Math.round((at - Date.parse(job.st.started || iso(at))) / 1000), tokens: job.st.tokens }, at);
  job.set({ state: 'cancelled', active: null, finished: iso(at), summary: 'Stopped from the pane.' });
}
// A small, believable diff so `agent-handoff review` on a demo job has something to show.
const SNIPPETS = {
  'src/export/csv.ts': [
    "+const cell = (v: unknown) => {",
    "+  const s = String(v ?? '')",
    "+  return /[\",\\n]/.test(s) ? `\"${s.replace(/\"/g, '\"\"')}\"` : s",
    "+}",
    "+",
    "+export const exportRowsToCsv = (cols: string[], rows: Row[]) =>",
    "+  [cols, ...rows.map((r) => cols.map((c) => r[c]))].map((r) => r.map(cell).join(',')).join('\\n')",
  ],
  'src/pages/Reports.tsx': [
    "   <Toolbar>",
    "+    <Button onClick={() => download(exportRowsToCsv(columns, visibleRows), 'report.csv')}>",
    "+      Download CSV",
    "+    </Button>",
    "   </Toolbar>",
  ],
  'tests/export.test.ts': [
    "+test('quotes commas, quotes and newlines', () => {",
    "+  expect(exportRowsToCsv(['a'], [{ a: 'x,\"y\"' }])).toBe('a\\n\"x,\"\"y\"\"\"')",
    "+})",
    "+test('an empty table exports just the header', () => {",
    "+  expect(exportRowsToCsv(['a', 'b'], [])).toBe('a,b')",
    "+})",
  ],
};
function fakeDiff(files) {
  return files.map((f) => {
    const body = SNIPPETS[f] || ['+// updated by the worker', '+export const updated = true'];
    return `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,4 +1,${body.length + 4} @@\n${body.join('\n')}`;
  }).join('\n');
}

const appendLedger = (home, row, at = Date.now()) => fs.appendFileSync(path.join(home, 'ledger.jsonl'), JSON.stringify({ ts: iso(at), ...row }) + '\n');

// ---------------------------------------------------------------------------
// The scene.

const CSV_TASK = 'Add a Download CSV button to the reports page that exports the rows currently shown in the table. Put the export logic in src/export/csv.ts and cover quoting and empty tables in tests/export.test.ts.';
const TZ_TASK = 'List every place the app reads the user’s time zone, with file:line, and flag any that ignore the account setting.';
const ARCHIVE_TASK = 'Add archived-project filtering to GET /api/projects and update the projects list page to match.';

const CSV_TOOLS = [
  ['shell', 'rg -n "ReportsTable" src', 0.4],
  ['shell', 'sed -n 1,120p src/pages/Reports.tsx', 0.3],
  ['shell', 'sed -n 1,80p src/hooks/useReportRows.ts', 0.3],
  ['edit', 'src/export/csv.ts', 0.8],
  ['edit', 'src/pages/Reports.tsx', 0.6],
  ['edit', 'tests/export.test.ts', 0.7],
  ['shell', 'npm test -- export', 2.2],
];
const TZ_DONE = [
  ['grep_search', 'resolvedOptions().timeZone'],
  ['view_file', 'src/api/reports.ts'],
  ['view_file', 'src/emails/digest.ts'],
  ['grep_search', 'account.timezone'],
];

function genericTools(kind, backend) {
  const sh = backend === 'codex' ? 'shell' : 'run_command';
  const read = backend === 'codex' ? (f) => ['shell', `sed -n 1,120p ${f}`, 0.3] : (f) => ['view_file', f, 0.4];
  const edit = backend === 'codex' ? 'edit' : 'replace_file_content';
  if (!['implement', 'tests', 'scaffold'].includes(kind)) return [read('src/lib/dates.ts'), read('src/api/reports.ts'), read('src/emails/digest.ts')];
  return [read('src/pages/Reports.tsx'), [edit, 'src/export/csv.ts', 0.8], [edit, 'tests/export.test.ts', 0.7], [sh, 'npm test -- export', 2]];
}

export class Scene {
  constructor(home) { this.home = home; this.jobs = new Map(); this.retries = 0; }

  reset() {
    const now = Date.now();
    fs.rmSync(path.join(this.home, 'jobs'), { recursive: true, force: true });
    fs.rmSync(path.join(this.home, 'ledger.jsonl'), { force: true });
    fs.mkdirSync(path.join(this.home, 'jobs'), { recursive: true });
    this.jobs.clear(); this.retries = 0;
    writeJSON(path.join(this.home, 'runtime.json'), { node: process.execPath, cli: CLI });
    const cfg = readJSON(path.join(this.home, 'config.json'));
    if (!cfg) writeJSON(path.join(this.home, 'config.json'), { backend: 'auto', autobench: true, workers: { agy: true, codex: true }, disabled_models: [], limits: { low: 0.2, stop: 0 } });
    this.quota(now);
    this.ledger(now);
    this.history(now);
    this.question(now - 6 * 60e3);
    this.timezones(now - 2 * 60e3);
    this.csv(now);
  }

  quota(now) {
    const inH = (h) => iso(now + h * 3600e3);
    writeJSON(path.join(this.home, 'quota.json'), { at: now, quota: { gemini5h: 0.64, geminiWeek: 0.72, argonWeek: 0.91, otherWeek: null, resets: { gemini5h: inH(2.4), geminiWeek: inH(80), argonWeek: inH(80) } } });
    writeJSON(path.join(this.home, 'codex-quota.json'), { at: now, quota: { codex5h: 0.81, codexWeek: 0.47, allowed: true, resets: { codex5h: inH(3.1), codexWeek: inH(55) }, plan: 'pro' } });
  }

  // ~70 past runs: who passes what, so the Bench tab has real lanes to rank.
  ledger(now) {
    const r = rng(7);
    const plan = [
      ['implement', [['gpt-6.2-sol:low', 9, 0.88, 140], ['gemini-4-hydrogen-high', 7, 0.71, 190], ['gemini-4-neon-medium', 5, 0.8, 230]]],
      ['tests', [['gpt-6-luna:medium', 8, 0.9, 95], ['gemini-4-neon-low', 6, 0.66, 120]]],
      ['analysis', [['gemini-4-neon-low', 9, 0.94, 60], ['gpt-6-luna:medium', 4, 0.85, 75], ['gemini-4-neon-medium', 3, 1, 110]]],
      ['search', [['gemini-4-hydrogen-low', 7, 0.86, 35], ['gpt-6-luna:low', 4, 0.75, 40]]],
      ['review', [['gpt-6.2-sol:high', 5, 0.9, 210], ['gemini-4-neon-high', 4, 0.75, 260]]],
    ];
    let t = now - 9 * 86400e3;
    for (const [kind, models] of plan) for (const [model, n, rate, secs] of models) for (let i = 0; i < n; i++) {
      t += 40 * 60e3 + r() * 3 * 3600e3;
      const id = `${stamp(t)}-h${String(Math.floor(r() * 1296).toString(36)).padStart(3, '0')}`;
      // Exactly round(n * rate) passes, so the Bench tab tells the same story every time.
      const pass = i < Math.round(n * rate);
      const v = pass ? 'pass' : r() < 0.6 ? 'partial' : 'fail';
      const backend = model.startsWith('gpt') ? 'codex' : 'agy';
      appendLedger(this.home, { type: 'run', id, backend, kind, model, state: 'done', turns: 1, duration_s: Math.round(secs * (0.7 + r() * 0.7)), tokens: { total: Math.round((secs * 650) * (0.7 + r() * 0.8)) }, questions: r() < 0.15 ? 1 : 0, stalls: 0, tests_pass: null }, t);
      appendLedger(this.home, { type: 'verdict', id, verdict: v, note: '', by: 'claude' }, t + 60e3);
    }
  }

  // Six finished jobs for the Jobs tab, each with a short timeline.
  history(now) {
    const done = [
      [26, 'agy', 'gemini-4-neon-low', 'analysis', false, 'Map how sessions are refreshed in src/auth and report the flow with file:line.', 'Sessions refresh in src/auth/refresh.ts:42 via a 5-minute timer; tokens rotate in src/auth/tokens.ts:88.', 'pass', 'Flow and line numbers check out.'],
      [22, 'codex', 'gpt-6-luna:medium', 'tests', true, 'Write unit tests for src/utils/money.ts covering rounding and negative amounts.', 'Added 14 tests in tests/money.test.ts; all pass.', 'pass', 'Covers rounding edge cases well.', ['tests/money.test.ts']],
      [19, 'codex', 'gpt-6.2-sol:low', 'implement', true, 'Add pagination to the invoices table (25 rows per page, keep filters in the URL).', 'Pagination added with URL-synced page and filters.', 'partial', 'Fixed an off-by-one on the last page.', ['src/pages/Invoices.tsx', 'src/hooks/usePagination.ts']],
      [8, 'agy', 'gemini-4-hydrogen-high', 'scaffold', true, 'Scaffold a settings page with tabs for Profile, Team and Billing, matching the existing page layout.', 'Created src/pages/settings/* with three tab components and routes.', 'pass', 'Matches the layout conventions.', ['src/pages/settings/index.tsx', 'src/pages/settings/Profile.tsx', 'src/pages/settings/Team.tsx', 'src/pages/settings/Billing.tsx']],
      [5, 'agy', 'gemini-4-hydrogen-low', 'search', false, 'Find the current rate limits for the Stripe API and summarise them.', 'Read requests: 100/s live, 25/s test; writes share the same pool.', 'pass', 'Sources cited.'],
      [2, 'codex', 'gpt-6.2-sol:high', 'review', false, 'Review the diff on branch feat/exports for bugs and missing tests.', 'Two issues: unescaped commas in csv.ts:31, and no test for an empty table.', 'pass', 'Both findings were real.'],
    ];
    for (const [hoursAgo, backend, model, kind, write, task, summary, v, note, files = []] of done) {
      const at = now - hoursAgo * 3600e3;
      const job = new Job(this.home, `${stamp(at)}-${backend === 'codex' ? 'c' : 'g'}${String(hoursAgo).padStart(3, '0')}`, {
        backend, model, kind, write, task, tests: write ? 'npm test' : null, created: iso(at), route_reasons: [`prior for ${kind}: ${model}`],
      });
      brief(job, at); pickup(job, at + 3000);
      toolHistory(job, genericTools(kind, backend), at + 5000);
      finish(job, at + 20000 + Math.round(hoursAgo * 997) % 60000, { summary, changed: write ? files : [], gate: write ? '✓ all tests passed' : null });
      verdict(job, at + 120e3, v, note);
      this.jobs.set(job.id, job);
    }
  }

  // agy, waiting on a question. Answering it from the pane resumes the story.
  question(at) {
    const job = new Job(this.home, `${stamp(at)}-a7q2`, {
      backend: 'agy', model: 'gemini-4-hydrogen-high', kind: 'implement', write: true, tests: 'npm test -- projects', task: ARCHIVE_TASK, created: iso(at),
      route_reasons: ['usage left: agy 64%, codex 47%', 'backend agy: most usage left', 'prior for implement: gemini-4-hydrogen-high'],
    });
    brief(job, at); pickup(job, at + 4000);
    toolHistory(job, [['view_file', 'src/api/projects.ts'], ['grep_search', 'archived'], ['view_file', 'src/db/schema.ts']], at + 6000);
    finish(job, at + 16000, { state: 'question', summary: 'Projects have an archived_at column but nothing filters on it yet.', question: 'Should archived projects be hidden by default, or only when ?archived=false is passed?' });
    job.onAnswer = (text) => {
      job.turn += 1;
      job.ev({ type: 'handoff', role: 'claude', mode: 'answer', text, backend: 'agy', model: job.meta.model });
      job.set({ state: 'starting', turn: job.turn, started: iso(Date.now()), question: undefined, summary: undefined, finished: undefined });
      job.run([
        [2, (now) => pickup(job, now)],
        ...toolSteps(job, [['replace_file_content', 'src/api/projects.ts', 0.9], ['replace_file_content', 'src/pages/Projects.tsx', 0.8], ['run_command', 'npm test -- projects', 2.2]], 3.5, 3),
        [13.5, (now) => finish(job, now, { summary: 'Archived projects are now hidden by default; ?archived=true includes them. List page has a Show archived toggle.', changed: ['src/api/projects.ts', 'src/pages/Projects.tsx'], gate: '✓ 9 tests passed (projects)' })],
        [20, (now) => verdict(job, now, 'pass', 'Default and query flag both work; toggle matches the design.')],
      ]);
    };
    this.jobs.set(job.id, job);
  }

  // agy, already a minute in, finishing during the recording.
  timezones(at) {
    const job = new Job(this.home, `${stamp(at)}-b4t9`, {
      backend: 'agy', model: 'gemini-4-neon-medium', kind: 'analysis', write: false, tests: null, task: TZ_TASK, created: iso(at),
      route_reasons: ['backend agy: best pass rate for analysis', 'prior for analysis (+2 complex): gemini-4-neon-medium'],
    });
    brief(job, at); pickup(job, at + 4000);
    toolHistory(job, [['grep_search', 'timeZone'], ['view_file', 'src/lib/dates.ts'], ['grep_search', 'Intl.DateTimeFormat'], ['view_file', 'src/components/Calendar.tsx']], at + 8000, 9);
    job.run([
      ...toolSteps(job, TZ_DONE, 1, 7),
      [32, (now) => finish(job, now, { summary: 'Seven reads of the time zone. Three ignore the account setting and use the browser’s: src/api/reports.ts:58, src/emails/digest.ts:23, src/components/Calendar.tsx:112.' })],
      [39, (now) => verdict(job, now, 'pass', 'Spot-checked all three; correct.')],
    ]);
    this.jobs.set(job.id, job);
  }

  // Codex, the newest job, which the pane follows: brief to rating in ~35 s.
  csv(at) {
    const job = new Job(this.home, `${stamp(at)}-c1v5`, {
      backend: 'codex', model: 'gpt-6.2-sol:low', kind: 'implement', write: true, tests: 'npm test -- export', task: CSV_TASK, created: iso(at),
      route_reasons: ['usage left: agy 64%, codex 47%', 'backend codex: best pass rate for implement runs', 'prior for implement: gpt-6.2-sol:low'],
    });
    brief(job, at);
    job.run([
      [2.5, (now) => pickup(job, now)],
      [3.4, (now) => thought(job, '**Finding the reports table**\n\nI’ll locate ReportsTable and the hook that feeds it rows, so the export uses exactly what is on screen, filters included.', now)],
      ...toolSteps(job, CSV_TOOLS, 4, 2.8),
      [11.8, (now) => thought(job, '**Planning the CSV export**\n\nA small exportRowsToCsv(columns, rows) in src/export/csv.ts. Any cell with a comma, quote or newline gets quoted, with embedded quotes doubled.', now)],
      [20.2, (now) => thought(job, '**Checking edge cases**\n\nAn empty table should still export its header row. I’ll cover that and the quoting rules, then run the export tests.', now)],
      [25, (now) => finish(job, now, { summary: 'Added exportRowsToCsv() in src/export/csv.ts (quotes commas, quotes and newlines) and a Download CSV button on the reports page that exports the filtered rows. 6 new tests.', changed: ['src/export/csv.ts', 'src/pages/Reports.tsx', 'tests/export.test.ts'], gate: '✓ 6 tests passed (export)\n  Test Files  1 passed (1)' })],
      [32, (now) => verdict(job, now, 'pass', 'Quoting is right and the button respects the active filters.')],
    ]);
    this.jobs.set(job.id, job);
  }

  // Requests the CLI left for demo jobs (Stop, Answer, Change model in the pane).
  requests(now) {
    for (const job of [...this.jobs.values()]) {
      const f = path.join(job.dir, 'demo-request.json');
      const req = readJSON(f);
      if (!req) continue;
      fs.rmSync(f, { force: true });
      if (req.type === 'answer' && job.st.state === 'question' && job.onAnswer) job.onAnswer(req.text);
      else if (req.type === 'cancel' && job.running) stop(job, now);
      else if (req.type === 'retry') this.retry(job, req, now);
    }
  }

  retry(old, req, now) {
    if (old.running) stop(old, now);
    const model = req.model || (req.backend === 'codex' ? 'gpt-6.2-sol:medium' : req.backend === 'agy' ? 'gemini-4-neon-medium' : old.meta.model);
    const backend = model.startsWith('gpt') ? 'codex' : 'agy';
    // A suffix that sorts after the scene's jobs, so the rerun is the newest job.
    const id = `${stamp(now)}-x${String(++this.retries).padStart(3, '0')}`;
    const job = new Job(this.home, id, {
      ...old.meta, demo: true, id, backend, model, created: iso(now), retry_of: old.id, conversation_id: undefined, totals: undefined, turns: undefined,
      route_reasons: [`rerun of ${old.id}`, req.model ? 'pinned with --model' : `prior for ${old.meta.kind}: ${model}`],
    });
    brief(job, now);
    const tools = genericTools(job.meta.kind, backend);
    job.run([
      [2, (t) => pickup(job, t)],
      ...toolSteps(job, tools, 3.5, 2.8),
      [4 + tools.length * 2.8, (t) => finish(job, t, { summary: `Done on ${model}: same change, re-checked against the brief.`, changed: job.meta.write ? ['src/export/csv.ts'] : [], gate: job.meta.tests ? '✓ tests passed' : null })],
      [11 + tools.length * 2.8, (t) => verdict(job, t, 'pass', 'Rerun on the new model is correct.')],
    ]);
    this.jobs.set(id, job);
  }

  step(now) {
    this.requests(now);
    for (const job of this.jobs.values()) job.step(now);
  }
}

export async function demo(o = {}) {
  const home = path.resolve(o.dir || path.join(os.homedir(), '.agent-handoff-demo'));
  // Never write over real handoff data: refuse ~/.agent-handoff, and any folder
  // holding a job that the demo didn't write.
  const real = path.resolve(path.join(os.homedir(), '.agent-handoff'));
  const jobsDir = path.join(home, 'jobs');
  const realJobs = fs.existsSync(jobsDir) && fs.readdirSync(jobsDir).some((n) => !readJSON(path.join(jobsDir, n, 'meta.json'))?.demo);
  if (home === real || realJobs) throw new Error(`${home} holds real handoff data; pick another folder with --dir`);
  fs.mkdirSync(path.join(home, 'jobs'), { recursive: true });
  const scene = new Scene(home);
  scene.reset();
  const short = home.replace(os.homedir(), '~');
  console.log(`Demo handoffs are in ${short}.

Open Claude Code on that folder (in another terminal):
  AGENT_HANDOFF_HOME=${short} claude
then type /handoff. The pane follows a Codex job from brief to rating; an agy
job is mid-run and another is waiting on a question (answer it from the pane).
Stop, Change model and the Settings tab work too.

Claude Code desktop app (macOS): launchctl setenv AGENT_HANDOFF_HOME ${home}
then quit and reopen the app; afterwards: launchctl unsetenv AGENT_HANDOFF_HOME`);
  if (o.once) return 0;
  const cycle = Number(o.cycle || 150) * 1000;
  console.log(`\nAnimating; the scene restarts every ${cycle / 1000}s. Ctrl+C to stop.`);
  let started = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const now = Date.now();
      try {
        if (o.loop !== false && now - started > cycle) { scene.reset(); started = now; }
        if (now % 60e3 < tick) scene.quota(now); // keep the usage meters fresh
        scene.step(now);
      } catch (e) { console.error(`demo: ${e.message}`); }
    }, tick);
    const done = () => { clearInterval(timer); resolve(); };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  console.log('\nDemo stopped. The sample data stays in place; run `agent-handoff demo` again to restart it.');
  return 0;
}
