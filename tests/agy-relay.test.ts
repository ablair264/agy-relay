import { expect, mock, test } from 'claude-code/testing'

const HOME = '/fake/.agy-relay'
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
    [`${HOME}/runtime.json`]: JSON.stringify({ node: '/usr/bin/node', cli: '/x/bin/agy-relay' }),
    [`${HOME}/ledger.jsonl`]: [
      { type: 'run', id: 'a', kind: 'implement', model: 'gemini-4-hydrogen-high', state: 'done', duration_s: 60, tokens: { total: 90000 }, tests_pass: true },
      { type: 'run', id: 'b', kind: 'analysis', model: 'gemini-4-neon-low', state: 'done', duration_s: 29, tokens: { total: 54000 } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n',
  }
  mock.env(on, { HOME: '/fake' })
  mock.store(on, store)
  on('session.id', () => ({ value: 'me' }))
  on('fs.list', ($: any, e: any) => ({ value: e.path.endsWith('/jobs') ? [{ name: ID, kind: 'directory', size: 0, isLink: false }] : [] }))
  on('fs.read', ($: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return files
}

const PANE = (surface: 'terminal' | 'desktop') => ({
  plugin: 'agy-relay', component: 'Pane', requestId: 'agy-relay', surface, viewport: { columns: 160, rows: 50 },
  props: { title: 'agy', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
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
  await $.command.run({ command: 'agy', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /^handed off → Hydrogen high · implement · write$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^worked · 3 tools · 1 failed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^asks: Which language should the greeting use\?$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^── TURN 1 · asking you · 31s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^agy Hydrogen high · 3 tools · 0 edits/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pre-tool hook/ })).toBeUndefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 'expand' })).toMatchObject({ props: { label: 'Collapse' } })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()

  await ui.input({ key: 'answer', text: 'Spanish' })
  await ui.input({ key: 'answer', text: 'Spanish' })
  expect(runs.length).toBe(1)
  expect(submitted.length).toBe(1)
  expect(runs[0].slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(runs[0].slice(-4)).toEqual(['/usr/bin/node', '/x/bin/agy-relay', ID, 'Spanish'])
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
  await $.command.run({ command: 'agy', args: '' })
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
  await $.command.run({ command: 'agy', args: 'm42e' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Awaiting Claude’s review · agy-relay review m42e$/ })).toBeDefined()
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
  expect(submitted[0]).toContain(`agy-relay review ${ID}`)
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
    plugin: 'agy-relay', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 160, rows: 50 },
    props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as any)
  expect(await band.find({ type: 'Text', text: /read_file greet\.mjs/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^5s\/4m 00s$/ })).toBeDefined()

  files[`${HOME}/jobs/${ID}/status.json`] = JSON.stringify(questionStatus)
  await clock.advance(1000)
  expect(toasts).toEqual(['agy asks: Which language should the greeting use?'])
  await band.unmount()
})

test('with the bench off a finished job shows no pending review', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  const files = fixture(on, { ...questionStatus, state: 'done', summary: 'Spanish greeting added.', question: undefined })
  files[`${HOME}/config.json`] = JSON.stringify({ backend: 'auto', bench: false })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'agy', args: '' })
  await clock.advance(1000)
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /^asks: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Awaiting Claude/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '── REVIEW' })).toBeUndefined()
  await ui.unmount()
})

test('the bench tab scores each kind and model', async ($, on) => {
  const clock = mock.clock(on, { now: T0 + 40e3 })
  fixture(on, questionStatus)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'agy', args: 'bench' })
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
  await $.tool.call({ tool: 'Bash', command: 'agy-relay run --write --dir . "do it"' })
  expect(opened).toEqual(['agy-relay'])
})
