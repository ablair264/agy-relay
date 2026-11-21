import { expect, mock, test } from 'claude-code/testing'

const HOME = '/fake/.agent-handoff'
const ID = '11120042-m42e'
const T0 = Date.parse('2026-11-12T01:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const meta = {
  id: ID, kind: 'implement', model: 'gemini-4-hydrogen-high', write: true, dir: '/work/repo', tests: 'node greet.test.mjs',
  stall_s: 240, startup_s: 90, task: 'In greet.mjs export greet(name); ask which language first.', route_reasons: ['prior for implement: gemini-4-hydrogen-high'],
}
const events = [
  { ts: at(0), turn: 1, type: 'handoff', role: 'claude', mode: 'brief', text: meta.task, model: meta.model, kind: 'implement', write: true, reasons: meta.route_reasons },
  { ts: at(5), turn: 1, type: 'pickup', conversation_id: 'c8a4932f-76e8' },
  { ts: at(16), turn: 1, type: 'tool', state: 'done', tool: 'run_command', arg: 'ls -la', dur: 0.3 },
  { ts: at(20), turn: 1, type: 'tool', state: 'error', tool: 'run_command', arg: 'cat a', msg: 'tool call denied by pre-tool hook', hook: true },
  { ts: at(24), turn: 1, type: 'tool', state: 'done', tool: 'read_file', arg: 'greet.test.mjs', dur: 0.1 },
  { ts: at(31), turn: 1, type: 'reply', role: 'agy', state: 'question', summary: 'Need the language.', question: 'Which language should the greeting use?', warnings: [], changed: [] },
  { ts: at(31), turn: 1, type: 'final', state: 'question', duration_s: 31, tokens: 54000 },
]
const questionStatus = { id: ID, state: 'question', turn: 1, started: at(0), last_event_at: at(31), finished: at(31), question: 'Which language should the greeting use?', summary: 'Need the language.', steps: 9, tool_calls: 3, tool_errors: 1 }
const workingStatus = { ...questionStatus, state: 'working', finished: undefined, question: undefined, active: { tool: 'read_file', arg: 'greet.mjs', since: at(25) }, last_event_at: at(25) }

function fixture(on: any, status: any, store: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}) {
  const files: Record<string, string> = {
    [`${HOME}/jobs/${ID}/meta.json`]: JSON.stringify({ ...meta, ...metaOver }),
    [`${HOME}/jobs/${ID}/status.json`]: JSON.stringify(status),
    [`${HOME}/jobs/${ID}/events.jsonl`]: events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    [`${HOME}/runtime.json`]: JSON.stringify({ node: '/usr/bin/node', cli: '/x/bin/agent-handoff' }),
    [`${HOME}/ledger.jsonl`]: [
      { type: 'run', id: 'a', kind: 'implement', model: 'gemini-4-hydrogen-high', state: 'done', duration_s: 60, tokens: { total: 90000 }, tests_pass: true },
      { type: 'run', id: 'b', kind: 'analysis', model: 'gemini-4-neon-low', state: 'done', duration_s: 29, tokens: { total: 54000 } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n',
  }
  mock.env(on, { HOME: '/fake' })
  mock.store(on, store)
  on('session.id', () => ({ value: 'me' }))
  // Lists every job the fixture holds, so a test can add a second one.
  const jobIds = () => [...new Set(Object.keys(files).map((f) => f.match(/\/jobs\/([^/]+)\//)?.[1]).filter(Boolean))]
  on('fs.list', ($: any, e: any) => ({ value: e.path.endsWith('/jobs') ? jobIds().map((name) => ({ name, kind: 'directory', size: 0, isLink: false })) : [] }))
  on('fs.read', ($: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return files
}

const PANE = (surface: 'terminal' | 'desktop') => ({
  plugin: 'agent-handoff', component: 'Pane', requestId: 'agent-handoff', surface, viewport: { columns: 160, rows: 50 },
  props: { title: 'handoff', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const)

test('the pane shows the handoff and lets you answer agy', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  fixture(on, questionStatus)
  const runs: string[][] = []
  const submitted: string[] = []
  on('process.run', ($: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /^Hydrogen high · implement · write · #m42e/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '? agy is asking you' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which language should the greeting use?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '── TIMELINE' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^handed off → Hydrogen high$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^worked · 3 tools · 1 failed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^asked: Which language should the greeting use\?$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^backend|prior for/ })).toBeUndefined() // routing reasons only when expanded
  expect(await ui.find({ type: 'Text', text: /pre-tool hook/ })).toBeUndefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 'expand' })).toMatchObject({ props: { label: 'Collapse' } })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()

  await ui.input({ key: 'answer', text: 'Spanish' })
  await ui.input({ key: 'answer', text: 'Spanish' })
  expect(runs.length).toBe(1)
  expect(submitted.length).toBe(1)
  expect(runs[0].slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(runs[0].slice(-4)).toEqual(['/usr/bin/node', '/x/bin/agent-handoff', ID, 'Spanish'])
  expect(submitted[0]).toContain(`job ${ID}`)
  await ui.unmount()
})

test('a codex job is labelled codex in the band, timeline and answer field', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  fixture(on, questionStatus, {}, { backend: 'codex', model: 'gpt-6.1-sol:low' })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /^codex$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^worked · 3 tools · 1 failed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^agy$/ })).toBeUndefined()
  expect(await ui.find({ key: 'answer' })).toMatchObject({ props: { label: 'Answer codex' } })
  await ui.unmount()
})

test('Desktop gets the activity strip; a finished job waits for Claude, not a button', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  fixture(on, { ...questionStatus, state: 'done', summary: 'Spanish greeting added.', question: undefined })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: 'm42e' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ Done · waiting for Claude’s review' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Claude reviews it with: agent-handoff review m42e' })).toBeDefined()
  expect(await ui.find({ key: 'verify-pass' })).toBeUndefined()
  await ui.unmount()
})

test('a finished job with no verdict prompts Claude to review it, once', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31e3 + 50e3 })
  fixture(on, { ...questionStatus, state: 'done', summary: 'Spanish greeting added.', question: undefined }, { claims: [{ session: 'me', at: T0 - 2000 }] })
  const submitted: string[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  await clock.advance(1000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain(`agent-handoff review ${ID}`)
})

test('a job another session launched is left for that session to review', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31e3 + 50e3 })
  fixture(on, { ...questionStatus, state: 'done', summary: 'done', question: undefined }, { claims: [{ session: 'other', at: T0 - 2000 }] })
  const submitted: string[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  expect(submitted.length).toBe(0)
})

test('a job no session claimed is not handed to whichever session looks first', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31e3 + 50e3 })
  fixture(on, { ...questionStatus, state: 'done', summary: 'done', question: undefined })
  const submitted: string[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  await clock.advance(1000)
  expect(submitted.length).toBe(0)
})

test('the band follows a live job and a toast says when agy asks', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 30e3 })
  const files = fixture(on, workingStatus)
  const toasts: string[] = []
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({
    plugin: 'agent-handoff', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 160, rows: 50 },
    props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as any)
  expect(await band.find({ type: 'Text', text: /read_file greet\.mjs/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^5s\/4m 00s$/ })).toBeDefined()

  files[`${HOME}/jobs/${ID}/status.json`] = JSON.stringify(questionStatus)
  await clock.advance(1000)
  expect(toasts).toEqual(['agy asks: Which language should the greeting use?'])
  await band.unmount()
})

test('with auto-benchmarking off a finished job shows no pending review', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  const files = fixture(on, { ...questionStatus, state: 'done', summary: 'Spanish greeting added.', question: undefined })
  files[`${HOME}/config.json`] = JSON.stringify({ backend: 'auto', autobench: false })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '✓ Done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for Claude|Claude reviews it/ })).toBeUndefined()
  await ui.unmount()
})

test('the bench tab scores each kind and model', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  fixture(on, questionStatus)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: 'bench' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '── IMPLEMENT' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '100% pass' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 1st ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 run\(s\) still need a rating/ })).toBeDefined()
  await ui.unmount()
})

test('a handoff from Claude opens the pane', async ($, on) => {
  mock.clock(on, { now: T0 })
  fixture(on, workingStatus)
  const opened: string[] = []
  on('ui.open', ($: any, e: any) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'agent-handoff run --write --dir . "do it"' })
  expect(opened).toEqual(['agent-handoff'])
})

test('auto-benchmark asks Claude to rate a finished job 20 s after it ends', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31e3 + 21e3 })
  fixture(on, { ...questionStatus, state: 'done', summary: 'done', question: undefined }, { claims: [{ session: 'me', at: T0 - 2000 }] })
  const submitted: string[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toMatch(/^Auto-benchmark: agent-handoff job .* \(agy\) finished/)
})

test('a config.json from before the rename (bench: false) still turns auto-benchmarking off', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31e3 + 50e3 })
  const files = fixture(on, { ...questionStatus, state: 'done', summary: 'done', question: undefined }, { claims: [{ session: 'me', at: T0 - 2000 }] })
  files[`${HOME}/config.json`] = JSON.stringify({ backend: 'auto', bench: false })
  const submitted: string[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  await clock.advance(1000)
  expect(submitted.length).toBe(0)
})

// The CLI owns config.json; this stand-in writes what `config autobench on|off` would.
function fakeCli(on: any, files: Record<string, string>, runs: string[][]) {
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    const i = e.argv.indexOf('autobench')
    if (e.argv.includes('config') && i > 0) files[`${HOME}/config.json`] = JSON.stringify({ backend: 'auto', autobench: e.argv[i + 1] === 'on' })
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
}

test('the bench tab switches auto-benchmarking off and on', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  const files = fixture(on, questionStatus)
  const runs: string[][] = []
  fakeCli(on, files, runs)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: 'bench' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: ' ON ' })).toBeDefined()
  await ui.press({ key: 'autobench' })
  expect(runs[0].slice(-3)).toEqual(['config', 'autobench', 'off'])
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: ' OFF ' })).toBeDefined()
  expect(await ui.find({ key: 'autobench' })).toMatchObject({ props: { label: 'Turn on' } })
  await ui.press({ key: 'autobench' })
  expect(runs[1].slice(-3)).toEqual(['config', 'autobench', 'on'])
  await ui.unmount()
})

test('/handoff autobench off turns it off from the prompt', async ($, on) => {
  mock.clock(on, { now: T0 + 40e3 })
  const files = fixture(on, questionStatus)
  const runs: string[][] = []
  fakeCli(on, files, runs)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r: any = await $.command.run({ command: 'handoff', args: 'autobench off' })
  expect(runs[0].slice(-3)).toEqual(['config', 'autobench', 'off'])
  expect(r.text).toMatch(/^Auto-benchmarking is off/)
})

// Two jobs at once: the agy job (ID) asking a question, and a newer codex job (ID2) working.
const ID2 = '11120043-x7k2'
function twoJobs(on: any, codexStatus: any = { ...workingStatus, id: ID2 }, store: Record<string, unknown> = {}) {
  const files = fixture(on, questionStatus, store)
  files[`${HOME}/jobs/${ID2}/meta.json`] = JSON.stringify({ ...meta, id: ID2, backend: 'codex', model: 'gpt-6.1-sol:low', stall_s: 480, task: 'Write tests for parser.ts', created: at(0) })
  files[`${HOME}/jobs/${ID2}/status.json`] = JSON.stringify(codexStatus)
  files[`${HOME}/jobs/${ID2}/events.jsonl`] = ''
  return files
}

test('the band shows a row for each job running at once', async ($, on) => {
  mock.clock(on, { now: T0 + 40e3 })
  twoJobs(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({
    plugin: 'agent-handoff', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 160, rows: 50 },
    props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as any)
  expect(await band.find({ type: 'Text', text: /^Sol 6\.1 low · read_file greet\.mjs$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^Hydrogen high · Which language/ })).toBeDefined()
  expect(await band.find({ key: `band-open-${ID}` })).toMatchObject({ props: { label: 'Answer' } })
  expect(await band.find({ key: `band-open-${ID2}` })).toMatchObject({ props: { label: 'Open' } })
  await band.unmount()
})

test('with more jobs than band rows, questions keep their row and the rest are counted', async ($, on) => {
  mock.clock(on, { now: T0 + 40e3 })
  twoJobs(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({
    plugin: 'agent-handoff', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 160, rows: 50 },
    props: { hasSurvey: false, isWorking: true, maxRows: 1, bodyColumns: 120, scroll: { offset: 0, bodyRows: 1 }, view: {} },
  } as any)
  expect(await band.find({ key: `band-open-${ID}` })).toBeDefined()
  expect(await band.find({ key: `band-open-${ID2}` })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: '+1 more' })).toBeDefined()
  await band.unmount()
})

test('the pane lists every active job above the timeline and switches on select', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  twoJobs(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '── IN PROGRESS · 2' })).toBeDefined()
  expect(await ui.find({ key: `active-${ID}` })).toBeDefined()
  expect(await ui.find({ key: `active-${ID2}` })).toBeDefined()
  // Following the newest job (the codex one): its timeline is shown, marked ▸.
  expect(await ui.find({ type: 'Text', text: /^Write tests for parser\.ts$/ })).toBeDefined()
  await ui.press({ key: `active-${ID}` })
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: 'Which language should the greeting use?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '── IN PROGRESS · 2' })).toBeDefined()
  await ui.unmount()
})

test('one job alone shows no active list', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  fixture(on, workingStatus)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /ACTIVE/ })).toBeUndefined()
  await ui.unmount()
})

test('an older job finishing while a newer one runs still gets its toast and review request', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  // Both jobs working; the older one (ID, agy) finishes, so it is not the newest job.
  const files = twoJobs(on, { ...workingStatus, id: ID2 }, { claims: [{ session: 'me', at: T0 - 2000 }] })
  files[`${HOME}/jobs/${ID}/status.json`] = JSON.stringify(workingStatus)
  const toasts: string[] = []
  const submitted: string[] = []
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  files[`${HOME}/jobs/${ID}/status.json`] = JSON.stringify({ ...workingStatus, state: 'done', active: undefined, finished: at(41), summary: 'Greeting added.' })
  await clock.advance(1000)
  expect(toasts).toEqual([`agy finished ${ID}; Claude reviews and rates it next`])
  await clock.advance(25e3)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain(`agent-handoff review ${ID}`)
})

// Settings tab, Stop and Change model. fakeCli (above) stands in for `agent-handoff config`.
function settingsCli(on: any, files: Record<string, string>, runs: string[][]) {
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    const a = e.argv.slice(e.argv.indexOf('config') + 1)
    if (e.argv.includes('config')) {
      const c = JSON.parse(files[`${HOME}/config.json`] || '{}')
      if (a[0] === 'worker') c.workers = { ...(c.workers || {}), [a[1]]: a[2] === 'on' }
      if (a[0] === 'model') c.disabled_models = a[2] === 'off' ? [...(c.disabled_models || []), a[1]] : (c.disabled_models || []).filter((m: string) => m !== a[1])
      if (a[0] === 'limit') c.limits = { low: 0.2, stop: 0, ...(c.limits || {}), [a[1]]: Number(a[2]) / 100 }
      if (a[0] === 'backend') c.backend = a[1]
      if (a[0] === 'ignore') c.ignored_models = [...(c.ignored_models || []), a[1]]
      files[`${HOME}/config.json`] = JSON.stringify(c)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
}

test('the settings tab turns workers and models on and off, picks the default worker and sets cut-offs', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  const files = fixture(on, questionStatus)
  const runs: string[][] = []
  settingsCli(on, files, runs)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: 'settings' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '── WORKERS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Antigravity · Gemini$/ })).toBeDefined()
  await ui.press({ key: 'worker-agy' })
  expect(runs.at(-1)!.slice(-4)).toEqual(['config', 'worker', 'agy', 'off'])
  await clock.advance(1000)
  expect(await ui.find({ key: 'worker-agy' })).toMatchObject({ props: { label: 'Turn on' } })
  expect(await ui.find({ type: 'Text', text: 'worker off' })).toBeDefined()

  await ui.press({ key: 'model-gpt-6-luna:low' })
  expect(runs.at(-1)!.slice(-4)).toEqual(['config', 'model', 'gpt-6-luna:low', 'off'])
  await clock.advance(1000)
  expect(await ui.find({ key: 'model-gpt-6-luna:low' })).toMatchObject({ props: { label: '○ Luna 6 low' } })
  expect(await ui.find({ type: 'Text', text: '5 of 6 on' })).toBeDefined()

  await ui.select({ key: 'default-worker', value: 'codex' })
  expect(runs.at(-1)!.slice(-3)).toEqual(['config', 'backend', 'codex'])
  await clock.advance(1000)
  expect(await ui.find({ key: 'default-worker' })).toMatchObject({ props: { value: 'codex' } })

  await ui.select({ key: 'limit-low', value: '25' })
  expect(runs.at(-1)!.slice(-4)).toEqual(['config', 'limit', 'low', '25'])
  await clock.advance(1000)
  await ui.select({ key: 'limit-stop', value: '0' }) // already off: nothing to run
  expect(runs.at(-1)!.slice(-4)).toEqual(['config', 'limit', 'low', '25'])
  await ui.select({ key: 'limit-stop', value: '5' })
  expect(runs.at(-1)!.slice(-4)).toEqual(['config', 'limit', 'stop', '5'])
  await clock.advance(1000)
  expect(await ui.find({ key: 'limit-stop' })).toMatchObject({ props: { value: '5' } })
  await ui.unmount()
})

test('Stop ends a running job and tells Claude it was the user', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 30e3 })
  fixture(on, workingStatus)
  const runs: string[][] = []
  const submitted: string[] = []
  on('process.run', ($: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ key: 'cancel' })).toMatchObject({ props: { label: 'Stop' } })
  await ui.press({ key: 'cancel' })
  expect(runs[0].slice(-2)).toEqual(['cancel', ID])
  expect(submitted[0]).toMatch(/^The user stopped agent-handoff job .* Don't restart it unless they ask/)
  await ui.unmount()
})

test('Change model lists the enabled models and reruns the job on the one picked', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 30e3 })
  const files = fixture(on, workingStatus)
  files[`${HOME}/config.json`] = JSON.stringify({ disabled_models: ['gemini-4-neon-xhigh'], workers: { agy: true, codex: false } })
  const runs: string[][] = []
  const submitted: string[] = []
  on('process.run', ($: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'change-model' })
  expect(await ui.find({ type: 'Text', text: '── STOP AND RESTART ON' })).toBeDefined()
  expect(await ui.find({ key: 'pick-gemini-4-neon-high' })).toBeDefined()
  expect(await ui.find({ key: 'pick-gemini-4-hydrogen-high' })).toBeUndefined() // the job's own model
  expect(await ui.find({ key: 'pick-gemini-4-neon-xhigh' })).toBeUndefined() // turned off
  expect(await ui.find({ key: 'pick-gpt-6.2-sol:low' })).toBeUndefined() // codex is off
  expect(await ui.find({ type: 'Text', text: /^7 models are turned off in Settings/ })).toBeDefined()
  await ui.press({ key: 'pick-gemini-4-neon-high' })
  expect(runs[0].slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(runs[0][2]).toContain('retry "$2" --model "$3"')
  expect(runs[0].slice(-2)).toEqual([ID, 'gemini-4-neon-high'])
  expect(submitted[0]).toMatch(/stopped agent-handoff job .* restarted the same task on gemini-4-neon-high/)
  expect(await ui.find({ type: 'Text', text: '── STOP AND RESTART ON' })).toBeUndefined()
  await ui.unmount()
})

test('demo jobs never message Claude when stopped from the pane', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 30e3 })
  fixture(on, workingStatus, {}, { demo: true })
  const submitted: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'cancel' })
  expect(submitted).toEqual([])
  await ui.unmount()
})

test("codex's reasoning shows in the band, on the THINK line and in the timeline", async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 30e3 })
  const thinking = { ...workingStatus, active: null, thought: { head: 'Planning the CSV export', at: at(26) } }
  const files = fixture(on, thinking, {}, { backend: 'codex', model: 'gpt-6.2-sol:low', stall_s: 480 })
  files[`${HOME}/jobs/${ID}/events.jsonl`] = [
    events[0], events[1],
    { ts: at(8), turn: 1, type: 'thought', text: '**Reading the reports page**\n\nThe table rows come from useReportRows.' },
    { ts: at(12), turn: 1, type: 'tool', state: 'done', tool: 'shell', arg: 'sed -n 1,80p src/pages/Reports.tsx', dur: 0.3 },
    { ts: at(26), turn: 1, type: 'thought', text: '**Planning the CSV export**\n\nQuote cells with commas, quotes or newlines.' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n'
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({
    plugin: 'agent-handoff', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 160, rows: 50 },
    props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as any)
  expect(await band.find({ type: 'Text', text: 'Sol 6.2 low · thinking: Planning the CSV export' })).toBeDefined()
  await band.unmount()

  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '⋯ Planning the CSV export' })).toBeDefined() // THINK line and latest in the burst
  expect(await ui.find({ type: 'Text', text: /^worked · 1 tool · 2 thoughts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⋯ Reading the reports page' })).toBeUndefined() // collapsed: latest only
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: '⋯ Reading the reports page' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Quote cells with commas, quotes or newlines.' })).toBeDefined()
  await ui.unmount()
})

test('a model a worker offers but no ladder knows is flagged once, with Ask Claude and Dismiss', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  const files = fixture(on, questionStatus)
  files[`${HOME}/codex-models.json`] = JSON.stringify({ at: T0, models: ['gpt-6.3-sol:low', 'gpt-6.3-sol:high', 'gpt-6.2-sol:low', 'gpt-6.1-sol:low'].map((id) => ({ id })) })
  files[`${HOME}/models.json`] = JSON.stringify({ at: T0, models: ['gemini-4-neon-low', 'claude-sonnet-5-5', 'gemini-3.8-flash-low'].map((id) => ({ id })) })
  const toasts: string[] = []
  const submitted: string[] = []
  const runs: string[][] = []
  settingsCli(on, files, runs)
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Only the new codex family: Claude models in agy, retired families and known ones are not flagged.
  expect(toasts).toEqual(["codex now offers Sol 6.3, which isn't on its ladder. See /handoff settings."])
  await $.command.run({ command: 'handoff', args: 'settings' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ key: 'tab-settings' })).toMatchObject({ props: { label: 'SETTINGS •' } })
  expect(await ui.find({ type: 'Text', text: ' NEW ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'low · high' })).toBeDefined()
  await ui.press({ key: 'ask-gpt-6.3-sol' })
  expect(submitted[0]).toMatch(/^agent-handoff: codex now offers gpt-6\.3-sol \(efforts: low, high\), which isn't on its model ladder\..*Don't change anything until I agree; then apply it with `agent-handoff config ladder codex/)
  await ui.press({ key: 'dismiss-gpt-6.3-sol' })
  expect(runs.at(-1)!.slice(-4)).toEqual(['config', 'ignore', 'gpt-6.3-sol', 'on'])
  expect(toasts.length).toBe(1)
  await ui.unmount()
})

test('with BenchLM data, settings shows price and scores per model and passes them to Claude', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  const files = fixture(on, questionStatus)
  // Made-up figures in BenchLM's shape.
  files[`${HOME}/benchlm.json`] = JSON.stringify({ at: T0, dataAsOf: '2026-01-02', attribution: 'Data from BenchLM.ai', models: {
    'gpt-6-2-sol': { name: 'GPT-6.2 Sol', price: { input: 2, output: 10 }, coding: { score: 51.2, rank: 4 }, agentic: { score: 52.6, rank: 4 } },
    'gpt-6-3-sol': { name: 'GPT-6.3 Sol', price: { input: 1, output: 5 }, coding: { score: 58, rank: 3 }, agentic: { score: 57, rank: 3 } },
  } })
  files[`${HOME}/codex-models.json`] = JSON.stringify({ models: [{ id: 'gpt-6.3-sol:low' }] })
  const submitted: string[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: 'settings' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '$/1M IN/OUT' })).toBeDefined()
  expect(await ui.find({ key: 'model-gpt-6.2-sol:low' })).toMatchObject({ props: { label: '✓ Sol 6.2 low' } })
  expect(await ui.find({ type: 'Text', text: '$2/$10' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '    51' })).toBeDefined() // coding, Sol 6.2
  expect(await ui.find({ type: 'Text', text: '     53' })).toBeDefined() // agentic, Sol 6.2
  expect(await ui.find({ type: 'Text', text: '· $1/$5 · coding 58 · agentic 57' })).toBeDefined() // the NEW row
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'https://benchlm.ai', label: 'Data from BenchLM.ai' } })
  await ui.press({ key: 'ask-gpt-6.3-sol' })
  expect(submitted[0]).toContain('BenchLM (data as of 2026-01-02) has Sol 6.3 at $1/$5 per 1M input/output tokens, coding 58 (#3), agentic 57 (#3); the current ladder: Sol 6.2: $2/$10 per 1M input/output tokens, coding 51.2 (#4), agentic 52.6 (#4).')
  await ui.unmount()
})

test('without BenchLM data, settings says how to add it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  fixture(on, questionStatus)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: 'settings' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'https://benchlm.ai/data/access', label: 'free BenchLM key' } })
  expect(await ui.find({ type: 'Text', text: 'RUNG' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$/1M IN/OUT' })).toBeUndefined()
  await ui.unmount()
})

// The reminder used to arrive while Claude was still reviewing a job it had just run,
// moments before (or after) it recorded the verdict.
function doneJob(on: any) {
  const files = fixture(on, { ...questionStatus, state: 'done', summary: 'done', question: undefined }, { claims: [{ session: 'me', at: T0 - 2000 }] })
  const submitted: string[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  return { files, submitted }
}

test('no review reminder for a job Claude has already looked at', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31e3 + 5e3 })
  const { submitted } = doneJob(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'agent-handoff review m42e' })
  await clock.advance(60e3)
  await clock.advance(60e3)
  expect(submitted).toEqual([])
})

test('the review reminder waits until Claude has been quiet, then comes once', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 31e3 + 25e3 }) // finished 25 s ago
  const { submitted } = doneJob(on)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Read', file_path: '/work/repo/greet.mjs' }) // Claude is busy with something
  await clock.advance(5e3)
  expect(submitted).toEqual([])
  await clock.advance(20e3) // 25 s without a tool call
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain(`agent-handoff review ${ID}`)
  await clock.advance(60e3)
  expect(submitted.length).toBe(1)
})

test('a finished, rated job reads as one card, with the relay notes and routing behind Expand', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 90e3 })
  const done = { ...questionStatus, state: 'done', question: undefined, summary: 'Added greet.mjs with a Spanish greeting.', changed: [' ?? greet.mjs'], tests_pass: true, warnings: ['agy did not return the JSON status object; summary is its raw reply tail'] }
  const files = fixture(on, done)
  files[`${HOME}/jobs/${ID}/events.jsonl`] += [
    { ts: at(40), turn: 2, type: 'reply', role: 'agy', state: 'done', summary: done.summary, changed: done.changed, warnings: done.warnings },
    { ts: at(41), turn: 2, type: 'gate', cmd: 'node greet.test.mjs', pass: true },
    { ts: at(60), turn: 2, type: 'verdict', role: 'claude', verdict: 'pass', note: 'Spanish greeting, tests pass' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n'
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'handoff', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '✓ Done · Claude rated it PASS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Added greet.mjs with a Spanish greeting.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'greet.mjs' })).toBeDefined() // FILES
  expect(await ui.find({ type: 'Text', text: '✓ passed · node greet.test.mjs' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Spanish greeting, tests pass' })).toBeDefined() // REVIEW
  expect(await ui.find({ type: 'Text', text: '1 note for Claude from the relay · e shows it' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^! agy did not return/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'turn 2' })).toBeDefined() // two turns: a label each
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /^! agy did not return the JSON status object/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'prior for implement: gemini-4-hydrogen-high' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'picked up · c8a4932f-76e8' })).toBeDefined()
  await ui.unmount()
})
