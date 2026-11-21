// Element trees for the agent-handoff pane and the band above the prompt.
// Takes the elements from $.ui.resolve(e) and plain data; never the mods API.
//
// The look, in a few rules:
//   Panels   framed boxes, ╭─ title ──── note ─╮, stacked with no gap. The frame
//            is dim; the job panel's frame takes its state's colour, so the one
//            coloured frame on screen is the job and what it is doing.
//   Text     labels muted, values at full strength, headings inside a panel in
//            the accent colour. Numbers in columns are right-aligned.
//   Controls toggles read (━━●) On / (●──) Off; meters are ■ cells on a · track.
//   Colour   status only: green ok, yellow needs you, red failed, blue working;
//            worker names keep their own colour. Every status has a glyph too.
// Every Text is mono so padded columns line up in Desktop too.
import {
  AGY, CLAUDE, CODEX, LADDER, LIVE, MODELS, OVERFLOW, STATE, WORKERS, activitySvg, benchFor, familyName, modelsFor, priceText, scoreText, thoughtParts, clip, fmtDur, fmtTok, idleBar, pct, shortModel, stateOf, timeline, toolKind, workerColor, workerOf,
} from './data.js'

const defined = (p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))
const T = (E, text, props = {}) => E.Text({ mono: true, ...defined(props), children: [String(text)] })
const dim = (E, text, props = {}) => T(E, text, { dimColor: true, ...props })
const row = (E, children, props = {}) => E.Box({ flexDirection: 'row', columnGap: 1, ...props, children })
const col = (E, children, props = {}) => E.Box({ flexDirection: 'column', ...props, children })
const fixed = (E, width, child) => E.Box({ width, flexShrink: 0, children: [child] })
const grow = (E, children) => E.Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', children })
// Left grows and truncates; right keeps its width so it never wraps.
const spread = (E, left, right) => E.Box({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', columnGap: 2, children: [grow(E, [left]), E.Box({ flexShrink: 0, children: [right] })] })
const keep = (E, child) => E.Box({ flexShrink: 0, children: [child] })
// A run of one glyph that fills whatever width is left on its line, in any app: an
// over-long run clipped to one row, so it never stops short or wraps. width 0 +
// flexGrow: it claims no width of its own (flexBasis isn't an allowed prop).
const LONG = 400
const fillRun = (E, glyph, ink) => E.Box({ flexGrow: 1, flexShrink: 1, width: 0, minWidth: 0, height: 1, overflow: 'hidden', children: [T(E, glyph.repeat(LONG), ink)] })
const ruleFill = (E) => fillRun(E, '─', { dimColor: true })

const ACCENT = 'magenta'
// Shared edges for the timeline: time | actor | text. Details (reasons, tool
// rows, warnings) hang under the actor column at DETAIL_X.
const TIME_W = 6, WHO_W = 7, DETAIL_X = TIME_W + 1
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`
const label = (E, text, color = AGY) => T(E, text.toUpperCase(), { color, weight: 'semibold' })
const levelColor = (f) => (f === null || f === undefined ? undefined : f > 0.5 ? 'green' : f > 0.2 ? 'yellow' : 'red')

// A framed panel. The top and bottom edges are rows of text, so the title and the
// note sit in the edge on every surface; the side bars are strips placed against
// the body (absolute, top to bottom) that clip a long run of │ to its height.
// The body has one cell of space inside each bar: 4 columns in all.
export const FRAME_W = 4
function panel(E, title, kids, o = {}) {
  const ink = o.frame ? { color: o.frame } : { dimColor: true }
  const edge = (s) => keep(E, T(E, s, ink))
  const bar = (side) => E.Box({ position: 'absolute', top: 0, bottom: 0, [side]: 0, width: 1, overflow: 'hidden', children: [T(E, '│'.repeat(LONG), { ...ink, wrap: 'wrap' })] })
  const name = typeof title === 'string' ? T(E, title, { weight: 'semibold' }) : title
  return col(E, [
    row(E, [edge('╭─ '), keep(E, name), edge(' '), fillRun(E, '─', ink), ...(o.note ? [edge(' '), keep(E, o.note), edge(' ─╮')] : [edge('╮')])], { columnGap: 0 }),
    E.Box({ flexDirection: 'column', paddingX: 2, children: [bar('left'), bar('right'), ...kids] }),
    row(E, [edge('╰'), fillRun(E, '─', ink), edge('╯')], { columnGap: 0 }),
  ], o.key ? { key: o.key } : {})
}
// A heading inside a panel: ACCENT LABEL ───────── (the rule dim, to the edge).
const sub = (E, text, note) => row(E, [keep(E, T(E, text.toUpperCase(), { color: ACCENT, weight: 'semibold' })), ruleFill(E), ...(note ? [keep(E, dim(E, note))] : [])])
// A label and its value: the label muted and fixed, the value at full strength.
const KV_W = 8
const kv = (E, k, v, kw = KV_W) => row(E, [fixed(E, kw, dim(E, k)), grow(E, [v])], { columnGap: 0, alignItems: 'flex-start' })
// A meter: ■ cells for the part filled, in colour, on a dim · track, so an empty
// meter never reads as a divider.
function meter(E, f, w, color) {
  const n = Math.round(Math.max(0, Math.min(1, f || 0)) * w)
  return row(E, [T(E, '■'.repeat(n), { color }), dim(E, '·'.repeat(w - n))], { columnGap: 0, flexShrink: 0 })
}
// A switch: the track shows the state in colour; the word beside it is the control
// (a label-only Button: one made of several Texts drew blank under the focus).
const toggle = (E, key, on, onPress, hotkey) => row(E, [
  keep(E, T(E, on ? '(━━●)' : '(●──)', on ? { color: 'green' } : { dimColor: true })),
  E.Button({ key, label: on ? 'On' : 'Off', hotkey, plain: true, dimColor: !on || undefined, onPress }),
], { columnGap: 1, flexShrink: 0 })
// Empty state: a dim glyph line plus an optional hint under it.
const empty = (E, text, hint) => [dim(E, `○ ${text}`), ...(hint ? [dim(E, `  ${hint}`, { wrap: 'wrap' })] : [])]

const ACTOR = { Claude: CLAUDE, You: CLAUDE, agy: AGY, codex: CODEX, relay: undefined }

// Mirrors the relay's watchdog: a shell command (agy run_command, codex shell) gets double the quiet time.
function idleOf(st, meta, now) {
  const idle = st.last_event_at ? (now - Date.parse(st.last_event_at)) / 1000 : 0
  const limit = st.state === 'starting' ? meta.startup_s || 90
    : (meta.stall_s || 240) * (/^(run_command|shell)$/.test(st.active?.tool || '') ? 2 : 1)
  return { idle, limit }
}

// What a job is doing, in a few words, for the band and the Active list.
function doingOf(st) {
  if (LIVE.has(st.state)) return st.active ? `${st.active.tool} ${st.active.arg || ''}` : st.state === 'starting' ? 'starting up' : st.thought?.head ? `thinking: ${st.thought.head}` : 'thinking'
  if (st.state === 'queued') return `queued behind ${st.queued_behind || 'another job'}`
  if (st.state === 'question') return st.question || ''
  return st.summary || ''
}

// Which jobs earn a row when there are more than fit: questions first, then running,
// queued and finished. Shown in start order so rows don't jump around.
const URGENCY = (s) => (/^(question|blocked)$/.test(s) ? 0 : LIVE.has(s) ? 1 : s === 'queued' ? 2 : 3)
function pick(jobs, n) {
  if (jobs.length <= n) return jobs
  const keep = new Set([...jobs].sort((a, b) => URGENCY(a.state) - URGENCY(b.state)).slice(0, n).map((j) => j.id))
  return jobs.filter((j) => keep.has(j.id))
}

// One band row: who + state | model · what it is doing | idle + action.
function bandRow(E, j, now, open, key, more) {
  const st = j.status, meta = j.meta
  const s = stateOf(j.state)
  const W = workerOf(meta)
  const kids = [
    keep(E, row(E, [fixed(E, 5, label(E, W, workerColor(W))), fixed(E, STATE_W, T(E, `${s.glyph} ${s.word}`, { color: s.color }))])),
    grow(E, [T(E, `${shortModel(meta.model)} · ${doingOf(st).replace(/\s+/g, ' ')}`, { wrap: 'truncate' })]),
  ]
  if (LIVE.has(st.state)) {
    const { idle, limit } = idleOf(st, meta, now)
    kids.push(keep(E, T(E, `${fmtDur(idle)}/${fmtDur(limit)}`, { color: idleBar(idle, limit).color, dimColor: idle / limit < 0.5 || undefined })))
  }
  kids.push(E.Button({ key, label: st.state === 'question' ? 'Answer' : 'Open', plain: true, onPress: open }))
  if (more) kids.push(keep(E, dim(E, `+${more} more`)))
  return row(E, kids, { columnGap: 2 })
}

// The band above the prompt: a row for every active job (a codex and an agy job can
// run at once, plus jobs from other sessions), up to the rows the band is given.
export function bands(E, m) {
  const { jobs, now } = m
  if (jobs.length === 1) return bandRow(E, jobs[0], now, () => m.open(jobs[0].id), 'band-open')
  const max = Math.max(1, Math.min(4, m.maxRows || 3))
  // A one-row band shows the most urgent job and counts the rest on the same line.
  if (max === 1) { const [j] = pick(jobs, 1); return bandRow(E, j, now, () => m.open(j.id), `band-open-${j.id}`, jobs.length - 1) }
  const shown = pick(jobs, jobs.length > max ? max - 1 : max)
  const rows = shown.map((j) => bandRow(E, j, now, () => m.open(j.id), `band-open-${j.id}`))
  if (shown.length < jobs.length) rows.push(dim(E, `+${jobs.length - shown.length} more · /handoff shows them all`))
  return col(E, rows)
}

// Below MIN_COLS the pane shows a polite message instead of a broken layout; when a
// panel's inside is under NARROW it drops secondary columns (state words, prices,
// the agentic score) and puts form controls under their labels.
export const MIN_COLS = 34, NARROW = 54

export function pane(E, m) {
  const cols = m.cols || 64
  if (cols < MIN_COLS) return col(E, [label(E, 'handoff'), dim(E, `Widen the pane to ${MIN_COLS} columns to see handoffs.`, { wrap: 'wrap' })])
  const w = cols - 2
  const tab = (id, text, hotkey) => E.Button({ key: 'tab-' + id, label: text, hotkey, plain: true, dimColor: m.tab !== id, onPress: () => m.actions.setTab(id) })
  const kids = [
    spread(E, label(E, 'handoff'), usageSummary(E, m.quota, (m.active || []).filter((a) => LIVE.has(a.state)).length)),
    row(E, [tab('live', 'LIVE', '1'), tab('jobs', 'JOBS', '2'), tab('bench', 'BENCH', '3'), tab('settings', m.newModels?.length ? 'SETTINGS •' : 'SETTINGS', '4')], { columnGap: w - FRAME_W < NARROW ? 2 : 3, flexWrap: 'wrap' }),
  ]
  if (m.notice) kids.push(T(E, m.notice, { color: 'yellow', wrap: 'wrap' }))
  const body = m.tab === 'jobs' ? jobsTab(E, m, w) : m.tab === 'bench' ? benchTab(E, m, w) : m.tab === 'settings' ? settingsTab(E, m, w) : liveTab(E, m, w)
  return col(E, [...kids, ...body])
}

// The title row's right end: usage left per worker, coloured by how much is left,
// and how many jobs are running. Workers go by the same names everywhere: agy, codex.
function usageSummary(E, q, running) {
  const parts = [['agy', usageLeft(q, 'agy')], ['codex', usageLeft(q, 'codex')]].filter(([, f]) => f !== null)
  const kids = parts.map(([name, f]) => row(E, [dim(E, name), T(E, pct(f), { color: levelColor(f), tabular: true })]))
  if (running) kids.push(T(E, `${running}●`, { color: STATE.working.color }))
  return kids.length ? row(E, kids, { columnGap: 3 }) : T(E, '')
}

// The Live tab, top to bottom, each a panel:
//   in progress   every other job running, queued or waiting on you (a table)
//   job #id       the task, one line of facts, then one coloured sentence saying
//                 what is happening; while it runs, what it is doing and thinking
//                 and how long it has been quiet; once it ends, the result. The
//                 frame takes the state's colour, the edge says the state and time.
//   timeline      who did what, in order, gate and rating included
// Then the key hints. Collapsed it shows what a person needs; `e` adds routing
// reasons, conversation ids, every tool call, full replies and the relay's notes.
function liveTab(E, m0, w) {
  const j = m0.job
  if (!j) return [panel(E, 'live', empty(E, 'No handoff yet', 'Ask Claude to hand a task off, or use /agent-handoff:codex-task or /agent-handoff:agy-task.'))]
  const wi = w - FRAME_W
  const st = j.status, meta = j.meta
  const W = workerOf(meta)
  const m = { ...m0, worker: W, w: wi }
  const s = stateOf(m.jobState)
  const running = LIVE.has(st.state) && m.jobState !== 'orphaned'
  const dur = meta.totals?.duration_s ?? (st.started ? (m.now - Date.parse(st.started)) / 1000 : null)
  const items = timeline(j.events)
  const verdictEv = [...j.events].reverse().find((ev) => ev.type === 'verdict')
  const gate = [...j.events].reverse().find((ev) => ev.type === 'gate')
  const out = []
  const act = activeList(E, m, wi)
  if (act) out.push(act)

  const card = [T(E, meta.task || '', { weight: 'semibold', wrap: 'wrap', maxLines: m.expanded ? undefined : 2 })]
  const facts = [shortModel(meta.model), meta.kind, meta.write ? 'write' : 'read-only', fmtTok(meta.totals?.tokens ?? st.tokens), (st.turn || 1) > 1 ? `${st.turn} turns` : '']
  card.push(row(E, [keep(E, label(E, W, workerColor(W))), grow(E, [dim(E, facts.filter(Boolean).join(' · '), { wrap: 'truncate' })])]))
  if (!m.following) card.push(dim(E, 'pinned to this job · l follows the newest'))
  if (m.svgOk) {
    const svg = activitySvg(j.events, m.now, running)
    if (svg) card.push(E.Svg({ source: svg, alt: `${W} activity over time`, width: 600, height: 22 }))
  }
  card.push(T(E, ' '), ...statusBlock(E, m, st, s, running, gate, verdictEv))
  const frame = s.color === 'gray' ? undefined : s.color
  out.push(panel(E, row(E, [T(E, 'job', { weight: 'semibold' }), dim(E, `#${j.id.slice(-4)}`)]), card, {
    frame, note: T(E, `${s.glyph} ${s.word}${dur !== null ? ` · ${fmtDur(dur)}` : ''}`, { color: frame, dimColor: !frame || undefined, tabular: true }),
  }))

  // The timeline; a label per turn only when there is more than one.
  const tl = turns(E, items, wi, running, m)
  if (!items.length && st.state !== 'queued') tl.push(...empty(E, 'Nothing recorded yet'))
  out.push(panel(E, 'timeline', tl.length ? tl : [dim(E, 'Starts when the job does.')], { note: (st.turn || 1) > 1 ? dim(E, `${st.turn} turns`) : undefined }))
  out.push(...actions(E, m, st, running))
  return out
}

// One coloured sentence for what is going on, then what goes with it, as labels
// and values.
function statusBlock(E, m, st, s, running, gate, verdictEv) {
  const W = m.worker
  const say = (text, color, extra = {}) => T(E, text, { color, weight: 'semibold', wrap: 'wrap', ...extra })
  const out = []
  if (m.jobState === 'orphaned') {
    out.push(say(`! The relay stopped answering: this job won't finish`, 'yellow'))
  } else if (st.state === 'queued') {
    out.push(say(`◌ Queued behind ${st.queued_behind || 'another job'} · starts when ${W} is free`, 'gray'))
  } else if (running) {
    const { idle, limit } = idleOf(st, m.job.meta, m.now)
    const b = idleBar(idle, limit)
    out.push(say(st.state === 'starting' ? `○ Starting ${W}…` : `● ${W} is working`, s.color))
    out.push(kv(E, 'Now', T(E, st.active ? `${st.active.tool} ${st.active.arg || ''}` : 'thinking', { wrap: 'truncate-middle' })))
    if (st.thought?.head) out.push(kv(E, 'Think', T(E, `⋯ ${st.thought.head}`, { color: workerColor(W), wrap: 'truncate' })))
    // The meter shrinks first, then the words, so the line never wraps.
    const narrow = m.w < NARROW
    out.push(kv(E, 'Quiet', row(E, [meter(E, limit ? idle / limit : 0, narrow ? 8 : 12, b.color), grow(E, [dim(E, narrow ? `${fmtDur(idle)} of ${fmtDur(limit)}` : `${fmtDur(idle)} · stalls at ${fmtDur(limit)}`, { wrap: 'truncate' })])])))
    if (st.warning) out.push(T(E, `! ${st.warning}`, { color: 'yellow', wrap: 'truncate' }))
  } else if (st.state === 'question') {
    out.push(say(`? ${W} is asking you`, 'yellow'))
    out.push(T(E, st.question || st.summary || '', { wrap: 'wrap' }))
    // The answer goes right under the question; the worker resumes the same conversation.
    out.push(E.Input({ key: 'answer', label: `Answer ${W}`, placeholder: `Type the answer; ${W} carries on in the same conversation`, value: '', submitLabel: 'send', onSubmit: m.actions.answer }))
  } else {
    const v = verdictEv?.verdict
    const vc = { pass: 'green', partial: 'yellow' }[v] || 'red'
    if (st.state === 'done' && v) out.push(say(`✓ Done · ${verdictEv.role && verdictEv.role !== 'claude' ? 'you' : 'Claude'} rated it ${v.toUpperCase()}`, vc))
    else if (st.state === 'done') out.push(say(m.benchOn !== false ? `✓ Done · waiting for Claude’s review` : '✓ Done', 'green'))
    else if (st.state === 'tests_failed') out.push(say(`✕ Finished, but the gate failed${v ? ` · rated ${v.toUpperCase()}` : ''}`, 'red'))
    else out.push(say(`${s.glyph} ${s.word[0].toUpperCase()}${s.word.slice(1)}`, s.color))
    // The result: what the worker says, what Git says changed, the gate.
    const summary = String(st.summary || '').trim()
    if (summary) out.push(kv(E, 'Result', T(E, m.expanded ? summary : clip(summary, 240), { wrap: 'wrap' })))
    const changed = (st.changed || []).map((c) => c.trim().replace(/^\S+\s+/, ''))
    if (changed.length) out.push(kv(E, 'Files', T(E, changed.join(', '), { wrap: 'truncate-middle' })))
    if (gate) out.push(kv(E, 'Gate', T(E, `${gate.pass ? '✓ passed' : '✕ failed'} · ${gate.cmd || ''}`, { color: gate.pass ? 'green' : 'red', wrap: 'truncate-middle' })))
    if (verdictEv?.note) out.push(kv(E, 'Review', dim(E, verdictEv.note, { wrap: 'wrap' })))
    if (st.state === 'done' && !v && m.benchOn !== false) out.push(dim(E, `Claude reviews it with: agent-handoff review ${String(m.job.id).slice(-4)}`, { wrap: 'truncate' }))
    const notes = (st.warnings || []).length
    if (notes && !m.expanded) out.push(dim(E, `${notes} note${notes === 1 ? '' : 's'} for Claude from the relay · e shows ${notes === 1 ? 'it' : 'them'}`, { wrap: 'wrap' }))
    if (m.expanded) for (const n of st.warnings || []) out.push(T(E, `! ${n}`, { color: 'yellow', wrap: 'wrap' }))
  }
  return out
}

// Every job in progress (running, queued, or waiting on an answer), as a table above
// the job, whenever one is going besides the job shown. ▸ marks the job shown
// below; select a row to show that one instead.
function activeList(E, m, w) {
  const act = (m.active || []).filter((a) => LIVE.has(a.state) || /^(queued|question|blocked)$/.test(a.state))
  if (!act.some((a) => a.id !== m.job?.id)) return null
  // Narrow: the state is its glyph alone, so the model and the step keep their room.
  const narrow = w < NARROW
  const stateW = narrow ? 2 : STATE_W
  const TIME_COL = 8
  const doingW = Math.max(8, w - 2 - stateW - 7 - MODEL_W - 2 - TIME_COL)
  const head = row(E, [fixed(E, 2, T(E, '')), fixed(E, stateW, dim(E, narrow ? '' : 'STATE')), fixed(E, 7, dim(E, 'WORKER')), grow(E, [dim(E, narrow ? 'MODEL · NOW' : `${'MODEL'.padEnd(MODEL_W)}  NOW`)]), keep(E, dim(E, 'TIME'.padStart(TIME_COL)))], { columnGap: 0 })
  const rows = act.map((a) => {
    const s = stateOf(a.state)
    const W = workerOf(a.meta)
    const st = a.status
    const shown = a.id === m.job?.id
    const right = LIVE.has(a.state) && st.started ? fmtDur((m.now - Date.parse(st.started)) / 1000)
      : a.state === 'queued' ? `#${st.position || 1}` : a.state === 'question' ? 'waiting' : ''
    return row(E, [
      fixed(E, 2, T(E, shown ? '▸' : ' ', { weight: 'semibold' })),
      fixed(E, stateW, T(E, narrow ? s.glyph : `${s.glyph} ${s.word}`, { color: s.color })),
      fixed(E, 7, T(E, W, { color: workerColor(W), weight: 'semibold' })),
      grow(E, [E.Button({ key: 'active-' + a.id, label: narrow ? clip(`${shortModel(a.meta.model)} · ${doingOf(st)}`, Math.max(8, w - 2 - stateW - 7 - TIME_COL)) : `${shortModel(a.meta.model).padEnd(MODEL_W)}  ${clip(doingOf(st), doingW)}`, plain: true, dimColor: !shown || undefined, onPress: () => m.actions.select(a.id) })]),
      keep(E, dim(E, right.padStart(TIME_COL), { tabular: true })),
    ], { columnGap: 0 })
  })
  return panel(E, `in progress · ${act.length}`, [head, ...rows])
}

// One line per event: dim time | actor (in its colour) | what happened.
// Top-aligned, so a wrapped message keeps its time and actor on its first line.
function line(E, at, who, text, props = {}) {
  return row(E, [
    fixed(E, TIME_W, dim(E, mmss(at))),
    fixed(E, WHO_W, T(E, who, { color: ACTOR[who], weight: 'semibold', dimColor: who === 'relay' || undefined })),
    grow(E, [T(E, text, { wrap: 'truncate', ...props })]),
  ], { alignItems: 'flex-start' })
}
// A detail under an event, hung from the actor column; branch draws ├─ or └─.
const detail = (E, children, branch) => row(E, [
  fixed(E, DETAIL_X, T(E, '')),
  ...(branch ? [keep(E, dim(E, branch === 'last' ? '└─' : '├─'))] : []),
  grow(E, children),
], { columnGap: branch ? 1 : 0, alignItems: 'flex-start' })
const shortWarning = (w) => String(w).replace(/(\d+) tool calls? denied by a pre-tool hook.*/, (_, n) => `${n} shell call${n === '1' ? '' : 's'} blocked by a pre-tool hook`)

function turns(E, items, w, running, m) {
  const byTurn = new Map()
  for (const it of items) {
    const n = it.turn ?? it.ev?.turn ?? 1
    if (!byTurn.has(n)) byTurn.set(n, [])
    if (it.kind !== 'final') byTurn.get(n).push(it)
  }
  const nums = [...byTurn.keys()].sort((a, b) => a - b)
  const out = []
  nums.slice(-6).forEach((n, i) => {
    if (nums.length > 1) {
      if (i > 0) out.push(T(E, ' '))
      out.push(dim(E, `turn ${n}`))
    }
    for (const it of byTurn.get(n)) out.push(...item(E, it, m))
  })
  return out
}

function item(E, it, m = {}) {
  const ev = it.ev || {}
  const W = m.worker || 'agy'
  switch (it.kind) {
    case 'brief': {
      const out = [line(E, it.at, 'Claude', `handed off → ${shortModel(ev.model)}`)]
      if (m.expanded) for (const r of ev.reasons || []) out.push(detail(E, [dim(E, r, { wrap: 'wrap' })]))
      return out
    }
    case 'answer':
      return [line(E, it.at, 'Claude', `answered: ${String(ev.text || '').replace(/\s+/g, ' ')}`)]
    case 'pickup':
      return [line(E, it.at, W, `${ev.turn > 1 ? 'resumed' : 'picked up'}${m.expanded && ev.conversation_id ? ` · ${String(ev.conversation_id)}` : ''}`)]
    case 'burst': {
      // Expanded: every step in order, reasoning summaries in full between the tools.
      if (m.expanded && it.thoughts?.length) return burstExpanded(E, it, W)
      const keepN = m.expanded ? 12 : 3
      const shown = it.tools.slice(-keepN)
      const edits = it.tools.filter((t) => t.state !== 'error' && toolKind(t.tool) === 'write').length
      const head = it.tools.length
        ? [`worked · ${it.tools.length} tool${it.tools.length === 1 ? '' : 's'}`, edits ? `${edits} edit${edits === 1 ? '' : 's'}` : '', it.errors ? `${it.errors} failed` : '', it.thoughts?.length ? `${it.thoughts.length} thought${it.thoughts.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
        : 'thinking'
      const out = [line(E, it.at, W, head)]
      const lastThought = it.thoughts?.at(-1)
      if (lastThought) out.push(detail(E, [T(E, `⋯ ${thoughtParts(lastThought.text).head}`, { color: workerColor(W), wrap: 'truncate' })], shown.length ? 'mid' : 'last'))
      if (it.tools.length > shown.length) out.push(detail(E, [dim(E, `+ ${it.tools.length - shown.length} earlier`)], 'mid'))
      shown.forEach((t, i) => {
        const err = t.state === 'error'
        const c = err ? (t.hook ? 'yellow' : 'red') : undefined
        out.push(detail(E, [row(E, [
          fixed(E, 12, T(E, t.tool, { color: c, wrap: 'truncate' })),
          grow(E, [dim(E, String(t.arg || '').replace(/\s+/g, ' '), { wrap: 'truncate-middle' })]),
          keep(E, T(E, err ? (t.hook ? 'hook denied' : 'failed') : t.dur ? `${t.dur.toFixed(1)}s` : '', { color: c, dimColor: !err || undefined })),
        ])], i === shown.length - 1 ? 'last' : 'mid'))
      })
      return out
    }
    case 'reply': {
      // The summary lives in the card's RESULT; the timeline says what happened.
      const s = stateOf(ev.state)
      if (ev.state === 'question') return [line(E, it.at, W, `asked: ${ev.question || ev.summary}`, { color: 'yellow', wrap: m.expanded ? 'wrap' : 'truncate' })]
      const word = ev.state === 'done' ? 'finished' : s.word
      const out = [line(E, it.at, W, m.expanded && ev.summary ? `${word}: ${ev.summary}` : word, { wrap: m.expanded ? 'wrap' : 'truncate', color: ev.state === 'done' ? undefined : s.color })]
      if (m.expanded && ev.changed?.length) out.push(detail(E, [dim(E, `changed  ${ev.changed.map((c) => c.trim()).join(', ')}`, { wrap: 'truncate-middle' })]))
      return out
    }
    case 'kill':
      return [line(E, it.at, 'relay', `stopped ${W}: ${ev.reason}${ev.active ? ` (in ${ev.active.tool})` : ''}`, { color: 'red' })]
    case 'gate':
      return [line(E, it.at, 'Claude', `gate ${ev.pass ? 'passed' : 'FAILED'}${m.expanded ? ` · ${ev.cmd || ''}` : ''}`, { color: ev.pass ? 'green' : 'red', wrap: 'truncate-middle' })]
    case 'verdict': {
      const c = { pass: 'green', partial: 'yellow' }[ev.verdict] || 'red'
      return [line(E, it.at, ev.role && ev.role !== 'claude' ? 'You' : 'Claude', `rated ${String(ev.verdict).toUpperCase()}`, { color: c, weight: 'semibold' })]
    }
    default:
      return []
  }
}

// A burst with its reasoning summaries: each thought's headline and body, and each
// tool call, in the order they happened (the last 14 steps).
function burstExpanded(E, it, W) {
  const steps = it.steps.slice(-14)
  const out = [line(E, it.at, W, `worked · ${it.tools.length} tool${it.tools.length === 1 ? '' : 's'} · ${it.thoughts.length} thought${it.thoughts.length === 1 ? '' : 's'}${it.errors ? ` · ${it.errors} failed` : ''}`)]
  if (it.steps.length > steps.length) out.push(detail(E, [dim(E, `+ ${it.steps.length - steps.length} earlier steps`)], 'mid'))
  steps.forEach((s, i) => {
    const branch = i === steps.length - 1 ? 'last' : 'mid'
    if (s.type === 'thought') {
      const { head, body } = thoughtParts(s.text)
      out.push(detail(E, [col(E, [
        T(E, `⋯ ${head}`, { color: workerColor(W), weight: 'semibold', wrap: 'wrap' }),
        ...(body ? [dim(E, body, { wrap: 'wrap' })] : []),
      ])], branch))
    } else {
      const err = s.state === 'error'
      const c = err ? (s.hook ? 'yellow' : 'red') : undefined
      out.push(detail(E, [row(E, [
        fixed(E, 12, T(E, s.tool, { color: c, wrap: 'truncate' })),
        grow(E, [dim(E, String(s.arg || '').replace(/\s+/g, ' '), { wrap: 'truncate-middle' })]),
        keep(E, T(E, err ? (s.hook ? 'hook denied' : 'failed') : s.dur ? `${s.dur.toFixed(1)}s` : '', { color: c, dimColor: !err || undefined })),
      ])], branch))
    }
  })
  return out
}

// The key hints under the panels: what can be done to this job, then moving between jobs.
function actions(E, m, st, running) {
  const out = []
  const btns = []
  const going = running || st.state === 'queued'
  if (going) btns.push(E.Button({ key: 'cancel', label: 'Stop', hotkey: 'c', onPress: m.actions.cancel }))
  btns.push(E.Button({ key: 'change-model', label: m.picking ? 'Keep model' : 'Change model', hotkey: 'm', plain: true, onPress: m.actions.togglePicker }))
  btns.push(E.Button({ key: 'expand', label: m.expanded ? 'Collapse' : 'Expand', hotkey: 'e', plain: true, onPress: m.actions.toggleExpand }))
  btns.push(E.Button({ key: 'older', label: '◀ Older', hotkey: 'o', plain: true, onPress: m.actions.older }))
  btns.push(E.Button({ key: 'newer', label: 'Newer ▶', hotkey: 'n', plain: true, onPress: m.actions.newer }))
  if (!m.following) btns.push(E.Button({ key: 'follow', label: 'Latest', hotkey: 'l', plain: true, onPress: m.actions.follow }))
  out.push(row(E, btns, { columnGap: 3, flexWrap: 'wrap', paddingX: 1 }))
  if (m.picking) out.push(modelPicker(E, m, going))
  return out
}

// Change model: every model that routing may use (worker on, model on), grouped by
// worker with this job's worker first. Picking one stops the job if it is still
// going and runs the same task again on that model, as a new job.
function modelPicker(E, m, going) {
  const s = m.settings
  const cur = m.job.meta.model
  const order = [workerOf(m.job.meta), ...['agy', 'codex'].filter((w) => w !== workerOf(m.job.meta))]
  const out = []
  let any = false
  for (const wk of order) {
    if (!s.workers[wk]) continue
    const models = modelsFor(s, wk).filter((id) => id !== cur && !s.disabled.has(id))
    if (!models.length) continue
    if (any) out.push(T(E, ' '))
    any = true
    out.push(sub(E, wk))
    for (const id of models) {
      out.push(row(E, [
        fixed(E, MODEL_W + 4, E.Button({ key: 'pick-' + id, label: `→ ${shortModel(id)}`, plain: true, onPress: () => m.actions.rerunOn(id) })),
        dim(E, modelNote(s, wk, id), { wrap: 'truncate' }),
      ], { columnGap: 0 }))
    }
  }
  if (!any) out.push(...empty(E, 'No other model is turned on', 'Turn more on in the Settings tab (4).'))
  const hidden = order.reduce((n, wk) => n + (s.workers[wk] ? modelsFor(s, wk).filter((id) => s.disabled.has(id)).length : modelsFor(s, wk).length), 0)
  out.push(T(E, ' '))
  if (hidden) out.push(dim(E, `${hidden} model${hidden === 1 ? ' is' : 's are'} turned off in Settings (4) and not listed.`, { wrap: 'wrap' }))
  out.push(dim(E, `Now on ${shortModel(cur)}. ${going ? 'The current run stops first; ' : ''}the rerun is a new job, and Claude reviews it.`, { wrap: 'wrap' }))
  return panel(E, going ? 'stop and restart on' : 'rerun this task on', out)
}

const modelNote = (s, wk, id) => (OVERFLOW.has(id) ? 'overflow · own weekly pool' : `rung ${modelsFor(s, wk).indexOf(id) + 1}${id === 'gemini-4-hydrogen-low' ? ' · lookups and digests' : ''}`)

// Settings: one panel laid out as a form, accent headings between its parts. Every
// change runs `agent-handoff config`, so the CLI validates it and routing sees it on
// the next handoff.
//   WORKERS          a switch per worker with its usage left, and the default worker
//   <WORKER> MODELS  a table: a toggle per model (one label-only Button, so the
//                    focus inverts the whole name), rung, and BenchLM's price and
//                    scores when the user has a key; overflow models grouped
//   USAGE CUT-OFFS   two Selects, and each worker's usage meter with both marked
//   AUTO-BENCHMARK   the same switch as the Bench tab
const COL = { rung: 6, price: 13, coding: 8, agentic: 9 }
const LABEL_W = 32
// Columns that give way, in this order, when the table is wider than the panel.
const DROP_ORDER = ['agentic', 'price', 'coding']
// The two cut-offs differ by weight as well as colour, so they read without colour.
const CUT = { low: { glyph: '│', color: 'yellow' }, stop: { glyph: '┃', color: 'red' } }
// A score this high is drawn green: the models worth reaching for.
const STRONG = 90

// A form row: label, then its control; when narrow, the control goes under its label.
const field = (E, w, lab, control) => (w < NARROW
  ? col(E, [lab, row(E, [fixed(E, 2, T(E, '')), control], { columnGap: 0 })])
  : row(E, [fixed(E, LABEL_W, lab), control]))

// Usage left in a worker's tighter window, or null when unknown.
function usageLeft(q, wk) {
  if (!q) return null
  const v = (wk === 'codex' ? [q.codex5h, q.codexWeek] : [q.gemini5h, q.geminiWeek]).filter((x) => x !== null && x !== undefined)
  return v.length ? Math.min(...v) : null
}

// A usage meter with the two cut-offs marked: ■ for what is left, then a mark at
// each cut-off (│ yellow: prefer the other worker below it; ┃ red: never use below it).
function usageBar(E, left, lim, width) {
  const n = Math.round(Math.max(0, Math.min(1, left)) * width)
  const mark = (f) => Math.min(width - 1, Math.max(0, Math.round(f * width)))
  const marks = new Map()
  if (lim.low) marks.set(mark(lim.low), 'low')
  if (lim.stop) marks.set(mark(lim.stop), 'stop')
  const fill = left < lim.stop ? 'red' : left < lim.low ? 'yellow' : 'green'
  // Runs of one look, so the bar is a handful of Texts, not one per cell.
  const runs = []
  for (let i = 0; i < width; i++) {
    const look = marks.has(i) ? `m:${marks.get(i)}` : i < n ? 'fill' : 'track'
    if (runs.length && runs.at(-1).look === look) runs.at(-1).len++
    else runs.push({ look, len: 1 })
  }
  return row(E, runs.map((r) => {
    if (r.look.startsWith('m:')) { const c = CUT[r.look.slice(2)]; return T(E, c.glyph.repeat(r.len), { color: c.color }) }
    return r.look === 'fill' ? T(E, '■'.repeat(r.len), { color: fill }) : dim(E, '·'.repeat(r.len))
  }), { columnGap: 0, flexShrink: 0 })
}

const pctOptions = (from, to, cur) => {
  const vals = new Set([cur])
  for (let v = from; v <= to; v += 5) vals.add(v)
  return [...vals].sort((x, y) => x - y).map((v) => ({ value: String(v), label: v ? `${v}%` : 'off' }))
}

function settingsTab(E, m, w) {
  const wi = w - FRAME_W
  const s = m.settings
  const a = m.actions
  const bl = m.benchlm
  const out = []

  // WORKERS
  out.push(sub(E, 'workers'))
  for (const wk of ['agy', 'codex']) {
    const on = s.workers[wk]
    const left = usageLeft(m.quota, wk)
    out.push(spread(E,
      row(E, [fixed(E, 6, label(E, wk, workerColor(wk))), dim(E, WORKERS[wk], { wrap: 'truncate' })]),
      row(E, [
        keep(E, left === null ? T(E, '') : T(E, `${pct(left)} left`, { color: on ? levelColor(left) : undefined, dimColor: !on || undefined, tabular: true })),
        toggle(E, 'worker-' + wk, on, () => a.toggleWorker(wk)),
      ], { columnGap: 2 })))
  }
  if (!s.workers.agy && !s.workers.codex) out.push(T(E, '! Both workers are off: handoffs fail until one is on.', { color: 'yellow', wrap: 'wrap' }))
  out.push(T(E, ' '), field(E, wi, T(E, 'Default worker'), E.Select({
    key: 'default-worker', value: s.backend, onSelect: (v) => a.setBackend(v),
    options: [{ value: 'auto', label: 'auto · picked per task' }, { value: 'agy', label: 'agy' }, { value: 'codex', label: 'codex' }],
  })))
  out.push(dim(E, s.backend === 'auto' ? 'From usage left, then pass rates for that kind of task.' : `Unless Claude or a command names the other worker.`, { wrap: 'wrap' }))

  // MODELS, one table per worker. Widths come from the names actually shown.
  const names = ['agy', 'codex'].flatMap((wk) => modelsFor(s, wk).map((id) => shortModel(id).length))
  const nameW = Math.max(12, ...names) + 4 // "✓ " and two spaces
  // BenchLM columns, minus any that don't fit the panel (agentic goes first, then price).
  const shownCols = bl ? ['price', 'coding', 'agentic'] : []
  for (const c of DROP_ORDER) {
    if (nameW + COL.rung + shownCols.reduce((n, k) => n + COL[k], 0) <= wi) break
    if (shownCols.includes(c)) shownCols.splice(shownCols.indexOf(c), 1)
  }
  const HEAD = { price: '$/1M IN/OUT', coding: 'CODING'.padStart(COL.coding - 2), agentic: 'AGENTIC'.padStart(COL.agentic - 2) }
  const head = () => row(E, [
    fixed(E, nameW, dim(E, '  MODEL')),
    fixed(E, COL.rung, dim(E, 'RUNG')),
    ...shownCols.map((c) => fixed(E, COL[c], dim(E, HEAD[c]))),
  ], { columnGap: 0 })
  const modelRow = (wk, id, rung, workerOff) => {
    const on = !s.disabled.has(id)
    const b = bl && benchFor(bl, id)
    const faint = !on || workerOff || undefined
    const score = (sc, width) => ({ text: (scoreText(sc) || '–').padStart(width - 2), strong: !faint && sc?.score >= STRONG })
    const cell = { price: () => ({ text: priceText(b) || '–' }), coding: () => score(b?.coding, COL.coding), agentic: () => score(b?.agentic, COL.agentic) }
    return row(E, [
      fixed(E, nameW, E.Button({ key: 'model-' + id, label: `${on ? '✓' : '○'} ${shortModel(id)}`, plain: true, dimColor: faint, onPress: () => a.toggleModel(id) })),
      fixed(E, COL.rung, T(E, rung, { dimColor: true })),
      ...shownCols.map((c) => { const v = cell[c](); return fixed(E, COL[c], T(E, v.text, { dimColor: faint, color: v.strong ? 'green' : undefined, tabular: true })) }),
    ], { columnGap: 0 })
  }
  for (const wk of ['agy', 'codex']) {
    const list = modelsFor(s, wk)
    const ladder = list.filter((id) => !OVERFLOW.has(id))
    const overflow = list.filter((id) => OVERFLOW.has(id))
    const workerOff = !s.workers[wk]
    const own = !!s.ladders?.[wk]
    const onCount = list.filter((id) => !s.disabled.has(id)).length
    out.push(T(E, ' '), sub(E, `${wk} models`, workerOff ? 'worker off' : `${own ? 'your ladder · ' : ''}${onCount} of ${list.length} on`))
    out.push(head())
    ladder.forEach((id, i) => out.push(modelRow(wk, id, String(i + 1), workerOff)))
    if (overflow.length) {
      out.push(dim(E, '  overflow · when the Gemini pool runs low', { wrap: 'truncate' }))
      for (const id of overflow) out.push(modelRow(wk, id, '–', workerOff))
    }
    if (!workerOff && !ladder.some((id) => !s.disabled.has(id))) out.push(T(E, `! Every ${wk} ladder model is off, so ${wk} won't be used.`, { color: 'yellow', wrap: 'wrap' }))
    // Models this worker offers that no ladder knows yet.
    const news = (m.newModels || []).filter((x) => x.worker === wk)
    for (const n of news) {
      const nb = bl && benchFor(bl, n.family)
      const figures = nb ? [priceText(nb), nb.coding ? `coding ${scoreText(nb.coding)}` : '', nb.agentic ? `agentic ${scoreText(nb.agentic)}` : ''].filter(Boolean).join(' · ') : n.efforts.join(' · ')
      out.push(spread(E,
        row(E, [keep(E, T(E, '✦ NEW', { color: 'cyan', weight: 'semibold' })), keep(E, T(E, familyName(n.family), { weight: 'semibold' })), dim(E, `· ${figures}`, { wrap: 'truncate' })]),
        row(E, [
          E.Button({ key: 'ask-' + n.family, label: 'Ask Claude', plain: true, onPress: () => a.askModel(n) }),
          E.Button({ key: 'dismiss-' + n.family, label: 'Dismiss', plain: true, dimColor: true, onPress: () => a.dismissModel(n) }),
        ], { columnGap: 2 })))
    }
    if (news.length) out.push(dim(E, `  Not on the ladder yet. Ask Claude where it fits; nothing changes until you agree.`, { wrap: 'wrap' }))
    if (own) out.push(row(E, [dim(E, '  Your own ladder ·'), E.Button({ key: 'reset-' + wk, label: 'Use the built-in one', plain: true, dimColor: true, onPress: () => a.resetLadder(wk) })]))
  }

  // USAGE CUT-OFFS: the two settings, then where each worker stands against them.
  const lim = s.limits
  const lowP = Math.round(lim.low * 100), stopP = Math.round(lim.stop * 100)
  out.push(T(E, ' '), sub(E, 'usage cut-offs'))
  const cutLabel = (which, text) => row(E, [keep(E, T(E, CUT[which].glyph, { color: CUT[which].color })), T(E, text)])
  out.push(field(E, wi, cutLabel('low', 'Prefer the other worker below'),
    E.Select({ key: 'limit-low', value: String(lowP), options: pctOptions(Math.max(5, stopP), 50, lowP), onSelect: (v) => a.setLimit('low', v) })))
  out.push(field(E, wi, cutLabel('stop', 'Never use a worker below'),
    E.Select({ key: 'limit-stop', value: String(stopP), options: pctOptions(0, Math.min(30, lowP), stopP), onSelect: (v) => a.setLimit('stop', v) })))
  const barW = Math.max(10, Math.min(30, wi - 6 - 2 - 22))
  for (const wk of ['agy', 'codex']) {
    const left = usageLeft(m.quota, wk)
    if (left === null) continue
    const state = !s.workers[wk] ? 'off' : left < lim.stop ? 'not used' : left < lim.low ? 'other preferred' : 'ok'
    out.push(row(E, [
      fixed(E, 6, label(E, wk, workerColor(wk))),
      usageBar(E, left, lim, barW),
      keep(E, T(E, `${pct(left).padStart(4)} ${state}`, { color: state === 'ok' ? 'green' : state === 'off' ? undefined : left < lim.stop ? 'red' : 'yellow', dimColor: state === 'off' || undefined, tabular: true })),
    ], { columnGap: 2 }))
  }
  out.push(dim(E, 'Usage left is the tighter of the 5-hour and weekly windows.', { wrap: 'wrap' }))

  // AUTO-BENCHMARK
  out.push(T(E, ' '), sub(E, 'auto-benchmark'), ...autobenchSwitch(E, m))

  // BenchLM's licence asks for a credit and a link wherever its numbers appear.
  // The row wraps rather than truncates, so the credit is never cut off.
  const credit = bl
    ? row(E, [keep(E, dim(E, 'Prices and scores:')), keep(E, E.Link({ href: 'https://benchlm.ai', label: 'Data from BenchLM.ai' })), keep(E, dim(E, `· ${bl.dataAsOf || ''}`)), ...(w < 86 ? [] : [dim(E, '· per model, every effort alike')])], { flexWrap: 'wrap', paddingX: 1 })
    : row(E, [keep(E, dim(E, 'Add prices and scores:')), keep(E, E.Link({ href: 'https://benchlm.ai/data/access', label: 'free BenchLM key' })), dim(E, '→ agent-handoff config benchlm-key <key>', { wrap: 'truncate' })], { flexWrap: 'wrap', paddingX: 1 })
  return [panel(E, 'settings', out), credit]
}

// Column widths come from the data, so no state word or model name overflows.
const STATE_W = Math.max(...Object.values(STATE).map((s) => s.word.length)) + 2
const MODEL_W = Math.max(...LADDER.map((x) => shortModel(x).length))

// Jobs: a table, newest first. ▸ marks the job the Live tab shows.
function jobsTab(E, m, w) {
  if (!m.jobs.length) return [panel(E, 'jobs', empty(E, 'No jobs yet', 'Handoffs appear here as Claude starts them.'))]
  const wi = w - FRAME_W
  const narrow = wi < NARROW
  const stateW = narrow ? 2 : STATE_W
  const taskW = Math.max(10, wi - 2 - stateW - 6 - MODEL_W - 4)
  const head = row(E, [fixed(E, 2, T(E, '')), fixed(E, stateW, dim(E, narrow ? '' : 'STATE')), grow(E, [dim(E, `${'ID'.padEnd(5)}  ${'MODEL'.padEnd(MODEL_W)}  TASK`)])], { columnGap: 0 })
  return [panel(E, 'jobs', [head, ...m.jobs.map((j) => {
    const s = stateOf(j.state)
    const shown = j.id === m.job?.id
    // Rows are a coloured state, then one label-only Button: a Button made of
    // several Texts drew blank under the terminal's focus highlight.
    return row(E, [
      fixed(E, 2, T(E, shown ? '▸' : ' ', { weight: 'semibold' })),
      fixed(E, stateW, T(E, narrow ? s.glyph : `${s.glyph} ${s.word}`, { color: s.color })),
      grow(E, [E.Button({ key: 'job-' + j.id, label: `#${j.id.slice(-4)}  ${shortModel(j.model).padEnd(MODEL_W)}  ${clip(j.task, taskW)}`, plain: true, dimColor: !shown || undefined, onPress: () => m.actions.select(j.id) })]),
    ], { columnGap: 0 })
  })], { note: dim(E, `${m.jobs.length}`) })]
}

// The auto-benchmarking switch, drawn the same on the Bench and Settings tabs: on,
// Claude rates every finished handoff and the ratings steer routing; off, nothing
// is rated and routing is fixed.
function autobenchSwitch(E, m) {
  const on = m.benchOn !== false
  return [
    spread(E,
      T(E, on ? 'Claude rates every finished handoff' : 'Finished handoffs are not rated', { wrap: 'truncate' }),
      toggle(E, 'autobench', on, m.actions.toggleAutobench, 'a')),
    dim(E, on ? 'Ratings pick the model for the next task of that kind.' : 'Each kind of task uses a fixed model.', { wrap: 'wrap' }),
  ]
}

// Bench: pass rates per kind of task, as tables ranked by pass rate, then speed.
// Columns give way from the right when the panel is narrow.
const BCOL = { runs: 6, median: 9, tokens: 8, stalls: 8 }
const BDROP = ['stalls', 'tokens', 'median', 'runs']
function benchTab(E, m, w) {
  const wi = w - FRAME_W
  const out = [panel(E, 'auto-benchmark', autobenchSwitch(E, m))]
  if (!m.bench?.length) return [...out, panel(E, 'pass rates', empty(E, 'No finished jobs in the ledger yet', 'Pass rates per model appear after the first runs.'))]
  const meterW = Math.max(6, Math.min(12, wi - 3 - MODEL_W - 5 - 4 - 30))
  const fixedW = 3 + MODEL_W + 1 + meterW + 6
  const cols = ['runs', 'median', 'tokens', 'stalls']
  for (const c of BDROP) {
    if (fixedW + cols.reduce((n, k) => n + BCOL[k], 0) <= wi) break
    cols.splice(cols.indexOf(c), 1)
  }
  const HEAD = { runs: 'RUNS', median: 'MEDIAN', tokens: 'TOKENS', stalls: 'STALLS' }
  // Right-aligned with a spare cell, and never wrapped: a DOM surface can make a box
  // a hair narrower than its text, and a padded cell that just fits would wrap.
  const right = (c, text, props = {}) => fixed(E, BCOL[c], T(E, String(text).padStart(BCOL[c] - 1), { tabular: true, wrap: 'clip', ...props }))
  const body = []
  let unverified = 0
  const kinds = [...new Set(m.bench.map((r) => r.kind))]
  kinds.forEach((kind, k) => {
    const lanes = m.bench.filter((r) => r.kind === kind).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || (a.medS ?? 1e9) - (b.medS ?? 1e9))
    if (k) body.push(T(E, ' '))
    body.push(sub(E, kind, `${lanes.length} model${lanes.length === 1 ? '' : 's'}`))
    body.push(row(E, [fixed(E, 3, dim(E, '#')), fixed(E, MODEL_W + 1, dim(E, 'MODEL')), fixed(E, meterW + 6, dim(E, 'PASS')), ...cols.map((c) => right(c, HEAD[c], { dimColor: true }))], { columnGap: 0 }))
    lanes.forEach((r, i) => {
      unverified += r.unverified
      const c = r.rate >= 0.85 ? 'green' : r.rate >= 0.7 ? 'yellow' : 'red'
      const cell = { runs: () => right('runs', r.runs), median: () => right('median', fmtDur(r.medS)), tokens: () => right('tokens', r.medTok ? `${Math.round(r.medTok / 1000)}k` : '–'), stalls: () => right('stalls', r.stalls || 0, r.stalls ? { color: 'red' } : { dimColor: true }) }
      body.push(row(E, [
        fixed(E, 3, dim(E, String(i + 1))),
        fixed(E, MODEL_W + 1, T(E, shortModel(r.model), { weight: i === 0 ? 'semibold' : undefined, wrap: 'truncate' })),
        meter(E, r.rate, meterW, c),
        fixed(E, 6, T(E, pct(r.rate).padStart(5), { color: c, weight: 'semibold', tabular: true })),
        ...cols.map((x) => cell[x]()),
      ], { columnGap: 0 }))
    })
  })
  body.push(T(E, ' '), dim(E, `Claude's rating or the test gate counts as a full run; the worker's own "done" counts half.${unverified ? ` ${unverified} run(s) still need a rating.` : ''}`, { wrap: 'wrap' }))
  return [...out, panel(E, 'pass rates', body)]
}
