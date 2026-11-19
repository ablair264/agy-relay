#!/usr/bin/env node
// Prints Codex's rate limits as JSON, read from `codex app-server` with
// account/rateLimits/read (no model turn, no usage). Run as a child so callers
// can stay synchronous: node codex-limits.mjs <codex-bin>
import { spawn } from 'node:child_process';

const bin = process.argv[2] || 'codex';
const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const done = (o) => { process.stdout.write(JSON.stringify(o)); try { child.kill(); } catch { /* gone */ } process.exit(0); };
setTimeout(() => done({ error: 'timeout' }), 12e3).unref();
child.on('error', (e) => done({ error: e.message }));

let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 2) done(m.result ? m.result : { error: m.error?.message || 'no result' });
  }
});
const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agy-relay', version: '0.3.0' } } });
send({ method: 'initialized' });
send({ id: 2, method: 'account/rateLimits/read' });
