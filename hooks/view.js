// Element trees for the agent-handoff pane and the band above the prompt.
// Takes the elements from $.ui.resolve(e) and plain data; never the mods API.
// Style: monospace throughout, small uppercase section labels, straight rules,
// no bordered boxes. Every Text is mono so padded columns line up in Desktop too.
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
// A rule that fills whatever width is left on its line, in any app: an over-long
// line of ─ clipped to one row, so it never stops short or wraps.
// width 0 + flexGrow: the rule's long text claims no width of its own and only fills
// what the label beside it leaves (flexBasis isn't an allowed prop).
const ruleFill = (E) => E.Box({ flexGrow: 1, flexShrink: 1, width: 0, minWidth: 0, height: 1, overflow: 'hidden', children: [dim(E, '─'.repeat(400))] })
const keep = (E, child) => E.Box({ flexShrink: 0, children: [child] })
// Shared edges for the timeline: time | actor | text. Details (reasons, tool
// rows, warnings) hang under the actor column at DETAIL_X.
const TIME_W = 6, WHO_W = 7, DETAIL_X = TIME_W + 1
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`
const label = (E, text, color = AGY) => T(E, text.toUpperCase(), { color, weight: 'semibold' })
const chip = (E, text, color) => T(E, ` ${text} `, { color, inverse: true, weight: 'semibold' })
const levelColor = (f) => (f === null || f === undefined ? undefined : f > 0.5 ? 'green' : f > 0.2 ? 'yellow' : 'red')
// One section heading style everywhere: ── LABEL ───────── (dim, fills the line).
const section = (E, text) => row(E, [keep(E, dim(E, `── ${text.toUpperCase()}`)), ruleFill(E)])
// A meter: filled part in colour, the rest as a dim track, so an empty meter
// never reads as a divider. Box-drawing only (block glyphs break in Desktop).
function meter(E, f, w, color) {
  const n = Math.round(Math.max(0, Math.min(1, f || 0)) * w)
  return row(E, [T(E, '━'.repeat(n), { color }), dim(E, '─'.repeat(w - n))], { columnGap: 0, flexShrink: 0 })
}
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

// Below MIN_COLS the pane shows a polite message instead of a broken layout; under
// NARROW it drops secondary columns (state words, prices, the agentic score).
export const MIN_COLS = 34, NARROW = 58

export function pane(E, m) {
  const cols = m.cols || 64
  if (cols < MIN_COLS) return col(E, [label(E, 'handoff'), dim(E, `Widen the pane to ${MIN_COLS} columns to see handoffs.`, { wrap: 'wrap' })])
  const w = cols - 2
  const tab = (id, text, hotkey) => E.Button({ key: 'tab-' + id, label: text, hotkey, plain: true, dimColor: m.tab !== id, onPress: () => m.actions.setTab(id) })
  // Groups are separated by space, not lines: title + tabs, quota, notice, body.
  const kids = [
    spread(E, label(E, 'handoff'), usageSummary(E, m.quota)),
    row(E, [tab('live', 'LIVE', '1'), tab('jobs', 'JOBS', '2'), tab('bench', 'BENCH', '3'), tab('settings', m.newModels?.length ? 'SETTINGS •' : 'SETTINGS', '4')], { columnGap: w < NARROW ? 2 : 3, flexWrap: 'wrap' }),
  ]
  if (m.notice) kids.push(T(E, ' '), T(E, m.notice, { color: 'yellow', wrap: 'wrap' }))
  kids.push(T(E, ' '))
  const body = m.tab === 'jobs' ? jobsTab(E, m) : m.tab === 'bench' ? benchTab(E, m, w) : m.tab === 'settings' ? settingsTab(E, m, w) : liveTab(E, m, w)
  return col(E, [...kids, ...body])
}

// Usage left per worker in the title row, coloured by how much is left; the bars
// with the cut-offs marked are on the Settings tab. Workers go by the same names
// everywhere in the pane: agy and codex.
function usageSummary(E, q) {
  const parts = [['agy', usageLeft(q, 'agy')], ['codex', usageLeft(q, 'codex')]].filter(([, f]) => f !== null)
  if (!parts.length) return T(E, '')
  return row(E, parts.map(([name, f]) => row(E, [dim(E, name), T(E, pct(f), { color: levelColor(f) })])), { columnGap: 3 })
}

// The Live tab, top to bottom:
//   IN PROGRESS   every other job running, queued or waiting on you (one row each)
//   the job card  task, one line of facts, then one coloured sentence saying what is
//                 happening now; while it runs, what it is doing and thinking and
//                 how long it has been quiet; once it ends, the result
//   TIMELINE      who did what, in order, gate and rating included
// Collapsed it shows what a person needs; `e` adds routing reasons, conversation
// ids, every tool call, full replies and the relay's notes meant for Claude.
function liveTab(E, m0, w) {
  const j = m0.job
  if (!j) return empty(E, 'No handoff yet', 'Ask Claude to hand a task off, or use /agent-handoff:codex-task or /agent-handoff:agy-task.')
  const st = j.status, meta = j.meta
  const W = workerOf(meta)
  const m = { ...m0, worker: W }
  const s = stateOf(m.jobState)
  const running = LIVE.has(st.state) && m.jobState !== 'orphaned'
  const dur = meta.totals?.duration_s ?? (st.started ? (m.now - Date.parse(st.started)) / 1000 : null)
  const items = timeline(j.events)
  const verdictEv = [...j.events].reverse().find((ev) => ev.type === 'verdict')
  const gate = [...j.events].reverse().find((ev) => ev.type === 'gate')
  const out = [...activeList(E, m, w)]

  // The card: task, facts, status.
  // The task is the heading; the status sentence below carries the state and colour.
  out.push(spread(E,
    T(E, meta.task || '', { weight: 'semibold', wrap: 'truncate' }),
    keep(E, T(E, fmtDur(dur), { color: running ? s.color : undefined, dimColor: !running || undefined }))))
  const facts = [shortModel(meta.model), meta.kind, meta.write ? 'write' : 'read-only', `#${j.id.slice(-4)}`, fmtTok(meta.totals?.tokens ?? st.tokens), (st.turn || 1) > 1 ? `${st.turn} turns` : '']
  out.push(row(E, [keep(E, label(E, W, workerColor(W))), grow(E, [dim(E, facts.filter(Boolean).join(' · '), { wrap: 'truncate' })])]))
  if (!m.following) out.push(dim(E, 'pinned to this job · l follows the newest'))
  if (m.svgOk) {
    const svg = activitySvg(j.events, m.now, running)
    if (svg) out.push(E.Svg({ source: svg, alt: `${W} activity over time`, width: 600, height: 22 }))
  }
  out.push(T(E, ' '), ...statusBlock(E, { ...m, w }, st, s, running, gate, verdictEv))

  // The timeline, one section; a rule per turn only when there is more than one.
  // The card already shows the duration, so the rule only counts turns.
  out.push(T(E, ' '), sectionNote(E, 'timeline', (st.turn || 1) > 1 ? `${st.turn} turns` : ''))
  if (!items.length && st.state !== 'queued') out.push(...empty(E, 'Nothing recorded yet'))
  out.push(...turns(E, items, w, running, m))
  out.push(...actions(E, m, st, running))
  return out
}

// One coloured sentence for what is going on, then what goes with it.
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
    out.push(row(E, [fixed(E, 7, dim(E, 'NOW')), grow(E, [T(E, st.active ? `${st.active.tool} ${st.active.arg || ''}` : 'thinking', { wrap: 'truncate-middle' })])]))
    if (st.thought?.head) out.push(row(E, [fixed(E, 7, dim(E, 'THINK')), grow(E, [T(E, `⋯ ${st.thought.head}`, { color: workerColor(W), wrap: 'truncate' })])]))
    // The meter shrinks first, then the words, so the line never wraps.
    const narrow = m.w < NARROW
    out.push(row(E, [fixed(E, 7, dim(E, 'QUIET')), meter(E, limit ? idle / limit : 0, narrow ? 8 : 16, b.color), grow(E, [dim(E, narrow ? `${fmtDur(idle)} of ${fmtDur(limit)}` : `${fmtDur(idle)} · stalls at ${fmtDur(limit)}`, { wrap: 'truncate' })])]))
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
    if (summary) out.push(row(E, [fixed(E, 7, dim(E, 'RESULT')), grow(E, [T(E, m.expanded ? summary : clip(summary, 240), { wrap: 'wrap' })])], { alignItems: 'flex-start' }))
    const changed = (st.changed || []).map((c) => c.trim().replace(/^\S+\s+/, ''))
    if (changed.length) out.push(row(E, [fixed(E, 7, dim(E, 'FILES')), grow(E, [T(E, changed.join(', '), { wrap: 'truncate-middle' })])]))
    if (gate) out.push(row(E, [fixed(E, 7, dim(E, 'GATE')), grow(E, [T(E, `${gate.pass ? '✓ passed' : '✕ failed'} · ${gate.cmd || ''}`, { color: gate.pass ? 'green' : 'red', wrap: 'truncate-middle' })])]))
    if (verdictEv?.note) out.push(row(E, [fixed(E, 7, dim(E, 'REVIEW')), grow(E, [dim(E, verdictEv.note, { wrap: 'wrap' })])], { alignItems: 'flex-start' }))
    if (st.state === 'done' && !v && m.benchOn !== false) out.push(dim(E, `Claude reviews it with: agent-handoff review ${String(m.job.id).slice(-4)}`, { wrap: 'truncate' }))
    const notes = (st.warnings || []).length
    if (notes && !m.expanded) out.push(dim(E, `${notes} note${notes === 1 ? '' : 's'} for Claude from the relay · e shows ${notes === 1 ? 'it' : 'them'}`))
    if (m.expanded) for (const n of st.warnings || []) out.push(T(E, `! ${n}`, { color: 'yellow', wrap: 'wrap' }))
  }
  return out
}

// Every job in progress (running, queued, or waiting on an answer), above the card,
// whenever one is going besides the job shown. ▸ marks the job shown below; select
// a row to show that one instead.
function activeList(E, m, w) {
  const act = (m.active || []).filter((a) => LIVE.has(a.state) || /^(queued|question|blocked)$/.test(a.state))
  if (!act.some((a) => a.id !== m.job?.id)) return []
  // Narrow: the state is its glyph alone, so the model and the step keep their room.
  const narrow = w < NARROW
  const stateW = narrow ? 2 : STATE_W
  const doingW = Math.max(8, w - 2 - stateW - 6 - MODEL_W - 9 - 4)
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
      grow(E, [E.Button({ key: 'active-' + a.id, label: narrow ? clip(`${shortModel(a.meta.model)} · ${doingOf(st)}`, Math.max(8, w - 2 - stateW - 7 - 9)) : `${shortModel(a.meta.model).padEnd(MODEL_W)}  ${clip(doingOf(st), doingW)}`, plain: true, dimColor: !shown || undefined, onPress: () => m.actions.select(a.id) })]),
      keep(E, dim(E, right.padStart(8))),
    ], { columnGap: 0 })
  })
  return [section(E, `in progress · ${act.length}`), ...rows, T(E, ' ')]
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
  out.push(T(E, ' '), row(E, btns, { columnGap: 3, flexWrap: 'wrap' }))
  if (m.picking) out.push(...modelPicker(E, m, going))
  return out
}

// Change model: every model that routing may use (worker on, model on), grouped by
// worker with this job's worker first. Picking one stops the job if it is still
// going and runs the same task again on that model, as a new job.
function modelPicker(E, m, going) {
  const s = m.settings
  const cur = m.job.meta.model
  const order = [workerOf(m.job.meta), ...['agy', 'codex'].filter((w) => w !== workerOf(m.job.meta))]
  const out = [T(E, ' '), section(E, going ? 'stop and restart on' : 'rerun this task on')]
  let any = false
  for (const wk of order) {
    if (!s.workers[wk]) continue
    const models = modelsFor(s, wk).filter((id) => id !== cur && !s.disabled.has(id))
    if (!models.length) continue
    any = true
    out.push(label(E, wk, workerColor(wk)))
    for (const id of models) {
      out.push(row(E, [
        fixed(E, MODEL_W + 4, E.Button({ key: 'pick-' + id, label: `→ ${shortModel(id)}`, plain: true, onPress: () => m.actions.rerunOn(id) })),
        dim(E, modelNote(s, wk, id), { wrap: 'truncate' }),
      ], { columnGap: 0 }))
    }
  }
  if (!any) out.push(...empty(E, 'No other model is turned on', 'Turn more on in the Settings tab (4).'))
  const hidden = order.reduce((n, wk) => n + (s.workers[wk] ? modelsFor(s, wk).filter((id) => s.disabled.has(id)).length : modelsFor(s, wk).length), 0)
  if (hidden) out.push(dim(E, `${hidden} model${hidden === 1 ? ' is' : 's are'} turned off in Settings (4) and not listed.`, { wrap: 'wrap' }))
  out.push(dim(E, `Now on ${shortModel(cur)}. ${going ? 'The current run stops first; ' : ''}the rerun is a new job, and Claude reviews it.`, { wrap: 'wrap' }))
  return out
}

const modelNote = (s, wk, id) => (OVERFLOW.has(id) ? 'overflow · own weekly pool' : `rung ${modelsFor(s, wk).indexOf(id) + 1}${id === 'gemini-4-hydrogen-low' ? ' · lookups and digests' : ''}`)

// A section heading with a note at the right end of its rule.
const sectionNote = (E, text, note) => row(E, [keep(E, dim(E, `── ${text.toUpperCase()}`)), ruleFill(E), keep(E, dim(E, note))])

// Settings, laid out as a form. Every change runs `agent-handoff config`, so the
// CLI validates it and routing sees it on the next handoff.
//   WORKERS          on/off, usage left, and the default worker (a Select)
//   <WORKER> MODELS  a table: a toggle per model (one label-only Button, so the
//                    focus inverts the whole name), rung, and BenchLM's price and
//                    scores when the user has a key; overflow models grouped
//   USAGE CUT-OFFS   two Selects, and each worker's usage bar with both marked
//   AUTO-BENCHMARK   the same switch as the Bench tab
const COL = { rung: 6, price: 13, coding: 8, agentic: 9 }
const LABEL_W = 32
// Columns that give way, in this order, when the table is wider than the pane.
const DROP_ORDER = ['agentic', 'price', 'coding']
// The two cut-offs differ by weight as well as colour, so they read without colour.
const CUT = { low: { glyph: '│', color: 'yellow' }, stop: { glyph: '┃', color: 'red' } }

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

// A usage bar with the two cut-offs marked: ━ used up to what is left, then a mark
// at each cut-off (│ yellow: prefer the other worker below it; ┃ red: never use below it).
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
    return r.look === 'fill' ? T(E, '━'.repeat(r.len), { color: fill }) : dim(E, '─'.repeat(r.len))
  }), { columnGap: 0, flexShrink: 0 })
}

const pctOptions = (from, to, cur) => {
  const vals = new Set([cur])
  for (let v = from; v <= to; v += 5) vals.add(v)
  return [...vals].sort((x, y) => x - y).map((v) => ({ value: String(v), label: v ? `${v}%` : 'off' }))
}

function settingsTab(E, m, w) {
  const s = m.settings
  const a = m.actions
  const bl = m.benchlm
  const out = []

  // WORKERS
  out.push(section(E, 'workers'))
  for (const wk of ['agy', 'codex']) {
    const on = s.workers[wk]
    const left = usageLeft(m.quota, wk)
    out.push(spread(E,
      row(E, [fixed(E, 6, label(E, wk, workerColor(wk))), keep(E, chip(E, on ? 'ON ' : 'OFF', on ? 'green' : 'gray')), dim(E, WORKERS[wk], { wrap: 'truncate' })]),
      row(E, [
        keep(E, left === null ? T(E, '') : T(E, `${pct(left)} left`, { color: on ? levelColor(left) : undefined, dimColor: !on || undefined })),
        E.Button({ key: 'worker-' + wk, label: on ? 'Turn off' : 'Turn on', plain: true, dimColor: on || undefined, onPress: () => a.toggleWorker(wk) }),
      ], { columnGap: 3 })))
  }
  if (!s.workers.agy && !s.workers.codex) out.push(T(E, '! Both workers are off: handoffs fail until one is on.', { color: 'yellow', wrap: 'wrap' }))
  out.push(T(E, ' '), field(E, w, T(E, 'Default worker'), E.Select({
    key: 'default-worker', value: s.backend, onSelect: (v) => a.setBackend(v),
    options: [{ value: 'auto', label: 'auto · picked per task' }, { value: 'agy', label: 'agy' }, { value: 'codex', label: 'codex' }],
  })))
  out.push(dim(E, s.backend === 'auto' ? 'From usage left, then pass rates for that kind of task.' : `Unless Claude or a command names the other worker.`, { wrap: 'wrap' }))

  // MODELS, one table per worker. Widths come from the names actually shown.
  const names = ['agy', 'codex'].flatMap((wk) => modelsFor(s, wk).map((id) => shortModel(id).length))
  const nameW = Math.max(12, ...names) + 4 // "✓ " and two spaces
  // BenchLM columns, minus any that don't fit the pane (agentic goes first, then price).
  const shownCols = bl ? ['price', 'coding', 'agentic'] : []
  for (const c of DROP_ORDER) {
    if (nameW + COL.rung + shownCols.reduce((n, k) => n + COL[k], 0) <= w) break
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
    const cell = { price: () => priceText(b) || '–', coding: () => (scoreText(b?.coding) || '–').padStart(COL.coding - 2), agentic: () => (scoreText(b?.agentic) || '–').padStart(COL.agentic - 2) }
    return row(E, [
      fixed(E, nameW, E.Button({ key: 'model-' + id, label: `${on ? '✓' : '○'} ${shortModel(id)}`, plain: true, dimColor: faint, onPress: () => a.toggleModel(id) })),
      fixed(E, COL.rung, T(E, rung, { dimColor: true })),
      ...shownCols.map((c) => fixed(E, COL[c], T(E, cell[c](), { dimColor: faint }))),
    ], { columnGap: 0 })
  }
  for (const wk of ['agy', 'codex']) {
    const list = modelsFor(s, wk)
    const ladder = list.filter((id) => !OVERFLOW.has(id))
    const overflow = list.filter((id) => OVERFLOW.has(id))
    const workerOff = !s.workers[wk]
    const own = !!s.ladders?.[wk]
    const onCount = list.filter((id) => !s.disabled.has(id)).length
    out.push(T(E, ' '), sectionNote(E, `${wk} models`, workerOff ? 'worker off' : `${own ? 'your ladder · ' : ''}${onCount} of ${list.length} on`))
    out.push(head(wk))
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
        row(E, [keep(E, chip(E, 'NEW', 'cyan')), keep(E, T(E, familyName(n.family), { weight: 'semibold' })), dim(E, `· ${figures}`, { wrap: 'truncate' })]),
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
  out.push(T(E, ' '), section(E, 'usage cut-offs'))
  const cutLabel = (which, text) => row(E, [keep(E, T(E, CUT[which].glyph, { color: CUT[which].color })), T(E, text)])
  out.push(field(E, w, cutLabel('low', 'Prefer the other worker below'),
    E.Select({ key: 'limit-low', value: String(lowP), options: pctOptions(Math.max(5, stopP), 50, lowP), onSelect: (v) => a.setLimit('low', v) })))
  out.push(field(E, w, cutLabel('stop', 'Never use a worker below'),
    E.Select({ key: 'limit-stop', value: String(stopP), options: pctOptions(0, Math.min(30, lowP), stopP), onSelect: (v) => a.setLimit('stop', v) })))
  const barW = Math.max(10, Math.min(30, w - 6 - 2 - 22))
  for (const wk of ['agy', 'codex']) {
    const left = usageLeft(m.quota, wk)
    if (left === null) continue
    const state = !s.workers[wk] ? 'off' : left < lim.stop ? 'not used' : left < lim.low ? 'other preferred' : 'ok'
    out.push(row(E, [
      fixed(E, 6, label(E, wk, workerColor(wk))),
      usageBar(E, left, lim, barW),
      keep(E, T(E, `${pct(left).padStart(4)} ${state}`, { color: state === 'ok' ? 'green' : state === 'off' ? undefined : left < lim.stop ? 'red' : 'yellow', dimColor: state === 'off' || undefined })),
    ], { columnGap: 2 }))
  }
  out.push(dim(E, 'Usage left is the tighter of the 5-hour and weekly windows.', { wrap: 'wrap' }))

  // AUTO-BENCHMARK
  out.push(T(E, ' '), ...autobenchSwitch(E, m))

  // BenchLM's licence asks for a credit and a link wherever its numbers appear.
  // The row wraps rather than truncates, so the credit is never cut off.
  out.push(T(E, ' '), bl
    ? row(E, [keep(E, dim(E, 'Prices and scores:')), keep(E, E.Link({ href: 'https://benchlm.ai', label: 'Data from BenchLM.ai' })), keep(E, dim(E, `· ${bl.dataAsOf || ''}`)), ...(w < 86 ? [] : [dim(E, '· per model, every effort alike')])], { flexWrap: 'wrap' })
    : row(E, [keep(E, dim(E, 'Add prices and scores:')), keep(E, E.Link({ href: 'https://benchlm.ai/data/access', label: 'free BenchLM key' })), dim(E, '→ agent-handoff config benchlm-key <key>', { wrap: 'truncate' })], { flexWrap: 'wrap' }))
  return out
}

// Column widths come from the data, so no state word or model name overflows.
const STATE_W = Math.max(...Object.values(STATE).map((s) => s.word.length)) + 2
const MODEL_W = Math.max(...LADDER.map((x) => shortModel(x).length))

function jobsTab(E, m) {
  if (!m.jobs.length) return empty(E, 'No jobs yet', 'Handoffs appear here as Claude starts them.')
  const w = Math.max(30, (m.cols || 64) - 2)
  const taskW = Math.max(10, w - STATE_W - 6 - MODEL_W - 3)
  return [section(E, 'jobs'), ...m.jobs.map((j) => {
    const s = stateOf(j.state)
    // Rows are a coloured state, then one label-only Button: a Button made of
    // several Texts drew blank under the terminal's focus highlight.
    return row(E, [
      fixed(E, STATE_W, T(E, `${s.glyph} ${s.word}`, { color: s.color })),
      grow(E, [E.Button({ key: 'job-' + j.id, label: `#${j.id.slice(-4)}  ${shortModel(j.model).padEnd(MODEL_W)}  ${clip(j.task, taskW)}`, plain: true, onPress: () => m.actions.select(j.id) })]),
    ], { columnGap: 0 })
  })]
}

// The auto-benchmarking switch, drawn the same on the Bench and Settings tabs: on,
// Claude rates every finished handoff and the ratings steer routing; off, nothing
// is rated and routing is fixed. The chip keeps one width so the row doesn't shift.
function autobenchSwitch(E, m) {
  const on = m.benchOn !== false
  return [
    section(E, 'auto-benchmark'),
    spread(E,
      row(E, [keep(E, chip(E, on ? 'ON ' : 'OFF', on ? 'green' : 'gray')), dim(E, on ? 'Claude rates every finished handoff' : 'Finished handoffs are not rated', { wrap: 'truncate' })]),
      E.Button({ key: 'autobench', label: on ? 'Turn off' : 'Turn on', hotkey: 'a', plain: true, dimColor: on || undefined, onPress: m.actions.toggleAutobench })),
    dim(E, on ? 'Ratings pick the model for the next task of that kind.' : 'Each kind of task uses a fixed model.', { wrap: 'wrap' }),
  ]
}

// Bench as race lanes: models ranked by pass rate, then speed, per kind of task.
function benchTab(E, m, w) {
  const out = [...autobenchSwitch(E, m), T(E, ' ')]
  if (!m.bench?.length) return [...out, ...empty(E, 'No finished jobs in the ledger yet', 'Pass rates per model appear after the first runs.')]
  // The meter takes what the rank, name and pass rate leave, up to 16 cells.
  const meterW = Math.max(6, Math.min(16, w - 5 - MODEL_W - 9 - 4))
  const kinds = [...new Set(m.bench.map((r) => r.kind))]
  let unverified = 0
  for (const kind of kinds) {
    out.push(section(E, kind))
    const lanes = m.bench.filter((r) => r.kind === kind).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || (a.medS ?? 1e9) - (b.medS ?? 1e9))
    lanes.forEach((r, i) => {
      unverified += r.unverified
      const c = r.rate >= 0.85 ? 'green' : r.rate >= 0.7 ? 'yellow' : 'red'
      // Two lines per model: rank · name · meter · pass rate, then the run stats.
      out.push(row(E, [
        keep(E, chip(E, ['1st', '2nd', '3rd'][i] || `${i + 1}th`, c)),
        fixed(E, MODEL_W, T(E, shortModel(r.model), { weight: 'semibold', wrap: 'truncate' })),
        meter(E, r.rate, meterW, c),
        keep(E, T(E, `${pct(r.rate).padStart(4)} pass`, { color: c, weight: 'semibold' })),
      ]))
      out.push(row(E, [fixed(E, 5, T(E, '')), grow(E, [dim(E, [`${r.runs} run${r.runs === 1 ? '' : 's'}`, `${fmtDur(r.medS)} median`, r.medTok ? `${Math.round(r.medTok / 1000)}k tok` : '', `${r.stalls} stalls`, `${r.questions || 0} questions`].filter(Boolean).join(' · '), { wrap: 'truncate' })])]))
    })
    out.push(T(E, ' '))
  }
  out.push(dim(E, `Claude's rating or the test gate counts as a full run; the worker's own "done" counts half.${unverified ? ` ${unverified} run(s) still need a rating.` : ''}`, { wrap: 'wrap' }))
  return out
}
