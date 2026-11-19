#!/usr/bin/env node
// Stand-in for the codex CLI in tests. Prints `codex exec --json` events in the
// documented shapes. FAKE_CODEX_MODE: question (ask, then on resume write greet.mjs),
// limit (the usage-limit error seen from a real run on 2026-11-12), silent (hang).
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(process.env.FAKE_CODEX_LOGGED_OUT ? 1 : 0); }
if (argv[0] === 'debug' && argv[1] === 'models') {
  const lv = (e) => e.map((effort) => ({ effort }));
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: lv(['low', 'medium', 'high']) },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: lv(['low', 'medium', 'high']) },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', supported_reasoning_levels: lv(['low', 'medium']) },
  ] }));
  process.exit(0);
}

if (argv[0] === 'app-server') {
  // account/rateLimits/read; FAKE_CODEX_USED="<5h %>,<week %>" (default 10,20)
  const [p, s] = (process.env.FAKE_CODEX_USED || '10,20').split(',').map(Number);
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    for (const line of buf.split('\n').slice(0, -1)) {
      const m = JSON.parse(line);
      if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { ordinaryUsageAllowed: s < 100, rateLimits: {
        primary: { usedPercent: p, windowDurationMins: 300, resetsAt: 4102444800 },
        secondary: { usedPercent: s, windowDurationMins: 10080, resetsAt: 4102444800 }, planType: 'plus' } } }) + '\n');
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
  });
} else {
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
fs.writeFileSync(path.join(process.env.AGY_RELAY_HOME, 'fake-codex-args.json'), JSON.stringify(argv));
const resume = argv[1] === 'resume';
const dir = process.cwd();
const last = opt('-o');
const status = (o) => JSON.stringify({ status: 'done', summary: '', question: '', files_changed: [], tests_run: '', notes: '', ...o });
const mode = process.env.FAKE_CODEX_MODE || 'question';

out({ type: 'thread.started', thread_id: resume ? argv[2] : 'thread-fake-1' });
out({ type: 'turn.started' });
if (mode === 'silent') setInterval(() => {}, 1000);
else if (mode === 'limit') {
  const msg = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 13th, 2099 8:32 PM.';
  out({ type: 'error', message: msg });
  out({ type: 'turn.failed', error: { message: msg } });
  process.exit(1);
} else {
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls'", status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls'", aggregated_output: 'greet.test.mjs\n', exit_code: 0, status: 'completed' } });
  let msg;
  if (!resume) {
    msg = status({ status: 'question', summary: 'Need the language.', question: 'Which language should the greeting use?' });
  } else {
    const f = path.join(dir, 'greet.mjs');
    fs.writeFileSync(f, "export const greet = (n) => `Hola, ${n}`;\n");
    out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: f, kind: 'add' }], status: 'completed' } });
    msg = status({ summary: 'Added greet.mjs with a Spanish greeting.', files_changed: [f], tests_run: 'none' });
  }
  out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: msg } });
  if (last) fs.writeFileSync(last, msg);
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300 } });
}
}
