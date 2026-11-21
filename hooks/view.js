// Element trees for the agent-handoff pane and the band above the prompt.
// Takes the elements from $.ui.resolve(e) and plain data; never the mods API.
// Style: monospace throughout, small uppercase section labels, straight rules,
// no bordered boxes. Every Text is mono so padded columns line up in Desktop too.
import {
  AGY, CLAUDE, CODEX, LADDER, LIVE, STATE, activitySvg, clip, fmtDur, fmtTok, idleBar, pct, shortModel, stateOf, timeline, toolKind, workerColor, workerOf,
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

export function band(E, m) {
  const { latest, now } = m
  const st = latest.status, meta = latest.meta
  const s = stateOf(m.latestState)
  let doing = ''
  if (LIVE.has(st.state)) doing = st.active ? `${st.active.tool} ${st.active.arg || ''}` : 'thinking'
  else if (st.state === 'question') doing = st.question || ''
  else doing = st.summary || ''
  // Three zones: who + state | model · what it is doing | idle + action.
  const W = workerOf(meta)
  const kids = [
    keep(E, row(E, [label(E, W, workerColor(W)), T(E, `${s.glyph} ${s.word}`, { color: s.color })])),
    grow(E, [T(E, `${shortModel(meta.model)} · ${doing.replace(/\s+/g, ' ')}`, { wrap: 'truncate' })]),
  ]
  if (LIVE.has(st.state)) {
    const { idle, limit } = idleOf(st, meta, now)
    kids.push(keep(E, T(E, `${fmtDur(idle)}/${fmtDur(limit)}`, { color: idleBar(idle, limit).color, dimColor: idle / limit < 0.5 || undefined })))
  }
  kids.push(E.Button({ key: 'band-open', label: st.state === 'question' ? 'Answer' : 'Open', plain: true, onPress: m.actions.open }))
  return row(E, kids, { columnGap: 2 })
}

export function pane(E, m) {
  const w = Math.max(30, (m.cols || 64) - 2)
  const tab = (id, text, hotkey) => E.Button({ key: 'tab-' + id, label: text, hotkey, plain: true, dimColor: m.tab !== id, onPress: () => m.actions.setTab(id) })
  // Groups are separated by space, not lines: title + tabs, quota, notice, body.
  const kids = [
    spread(E, label(E, 'handoff'), dim(E, m.job ? `${m.job.id} · ${shortModel(m.job.meta.model)}` : '')),
    row(E, [tab('live', 'LIVE', '1'), tab('jobs', 'JOBS', '2'), tab('bench', 'BENCH', '3')], { columnGap: 3 }),
  ]
  if (m.quota) kids.push(T(E, ' '), ...quotaMeters(E, m.quota))
  if (m.notice) kids.push(T(E, ' '), T(E, m.notice, { color: 'yellow', wrap: 'wrap' }))
  kids.push(T(E, ' '))
  const body = m.tab === 'jobs' ? jobsTab(E, m) : m.tab === 'bench' ? benchTab(E, m, w) : liveTab(E, m, w)
  return col(E, [...kids, ...body])
}

function quotaMeters(E, q) {
  return [['gemini 5h', q.gemini5h], ['gemini week', q.geminiWeek], ['argon week', q.argonWeek], ['codex 5h', q.codex5h], ['codex week', q.codexWeek]]
    .filter(([, f]) => f !== null && f !== undefined)
    .map(([name, f]) => row(E, [
      fixed(E, 12, dim(E, name.toUpperCase())),
      meter(E, f, 20, levelColor(f)),
      T(E, `${pct(f).padStart(4)} left`, { color: levelColor(f) }),
    ]))
}

function liveTab(E, m0, w) {
  const j = m0.job
  if (!j) return empty(E, 'No handoff yet', 'Ask Claude to hand a task off, or use /agent-handoff:codex-task or /agent-handoff:agy-task.')
  const st = j.status, meta = j.meta
  const W = workerOf(meta)
  const m = { ...m0, worker: W }
  const s = stateOf(m.jobState)
  const running = LIVE.has(st.state) && m.jobState !== 'orphaned'
  const dur = meta.totals?.duration_s ?? (st.started ? (m.now - Date.parse(st.started)) / 1000 : null)
  const tools = j.events.filter((ev) => ev.type === 'tool' && ev.state !== 'start')
  const edits = tools.filter((ev) => ev.state !== 'error' && /write|replace|edit|sed_file/.test(ev.tool || '')).length
  const gate = [...j.events].reverse().find((ev) => ev.type === 'gate')
  const out = [
    spread(E, row(E, [chip(E, s.word.toUpperCase(), s.color), T(E, clip(meta.task, 200), { weight: 'semibold', wrap: 'truncate' })]),
      T(E, `${running ? 'ELAPSED' : 'TOOK'} ${fmtDur(dur)}`, { color: s.color, weight: 'semibold' })),
  ]
  // Desktop gets the activity strip; the terminal goes straight to the stats line.
  if (m.svgOk) {
    const svg = activitySvg(j.events, m.now, running)
    if (svg) out.push(E.Svg({ source: svg, alt: `${W} activity over time`, width: 600, height: 22 }))
  }
  const stats = [`${W} ${shortModel(meta.model)}`, `${tools.length} tools`, `${edits} edit${edits === 1 ? '' : 's'}`]
  if (gate) stats.push(`gate ${gate.pass ? 'pass' : 'FAIL'}`)
  stats.push(fmtTok(meta.totals?.tokens ?? st.tokens), `${st.turn || 1} turn${(st.turn || 1) === 1 ? '' : 's'}`, meta.kind)
  out.push(dim(E, stats.filter(Boolean).join(' · '), { wrap: 'truncate' }))
  if (!m.following) out.push(dim(E, 'pinned to this job · l follows the latest'))

  if (running) {
    const { idle, limit } = idleOf(st, meta, m.now)
    const b = idleBar(idle, limit)
    out.push(T(E, ' '))
    out.push(row(E, [fixed(E, 6, dim(E, 'NOW')), grow(E, [T(E, st.active ? `${st.active.tool} ${st.active.arg || ''}` : st.state === 'starting' ? 'starting up' : 'thinking', { wrap: 'truncate-middle' })])]))
    out.push(row(E, [fixed(E, 6, dim(E, 'IDLE')), meter(E, limit ? idle / limit : 0, 20, b.color), dim(E, `${fmtDur(idle)} of ${fmtDur(limit)} before stall`)]))
  }
  if (st.state === 'queued') out.push(T(E, ' '), dim(E, `Queued behind ${st.queued_behind || 'another job'} · position ${st.position || 1}. Starts on its own when ${W} is free.`, { wrap: 'wrap' }))
  if (st.warning) out.push(T(E, `! ${st.warning}`, { color: 'yellow', wrap: 'truncate' }))

  out.push(T(E, ' '))
  const items = timeline(j.events)
  if (!items.length && st.state !== 'queued') out.push(...empty(E, 'No events recorded for this job'))
  out.push(...turns(E, items, w, running, m))
  out.push(...review(E, items, st, running, m))
  out.push(...actions(E, m, st, running))
  return out
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
    if (it.kind === 'gate' || it.kind === 'verdict') continue
    const n = it.turn ?? it.ev?.turn ?? 1
    if (!byTurn.has(n)) byTurn.set(n, { events: [], final: null })
    if (it.kind === 'final') byTurn.get(n).final = it.ev
    else byTurn.get(n).events.push(it)
  }
  const out = []
  const nums = [...byTurn.keys()].sort((a, b) => a - b)
  nums.slice(-6).forEach((n, i) => {
    const t = byTurn.get(n)
    const tail = t.final ? `${stateOf(t.final.state).word} · ${fmtDur(t.final.duration_s)}${t.final.tokens ? ` · ${fmtTok(t.final.tokens)}` : ''}` : running ? 'in progress' : ''
    if (i > 0) out.push(T(E, ' '))
    out.push(row(E, [keep(E, dim(E, `── TURN ${n}${tail ? ` · ${tail}` : ''}`, { wrap: 'truncate' })), ruleFill(E)]))
    for (const it of t.events) out.push(...item(E, it, m))
  })
  return out
}

function item(E, it, m = {}) {
  const ev = it.ev || {}
  const W = m.worker || 'agy'
  switch (it.kind) {
    case 'brief': {
      const out = [line(E, it.at, 'Claude', `handed off → ${shortModel(ev.model)} · ${ev.kind}${ev.write ? ' · write' : ''}`)]
      if (ev.reasons?.[0]) out.push(detail(E, [dim(E, ev.reasons[0], { wrap: 'truncate' })]))
      return out
    }
    case 'answer':
      return [line(E, it.at, 'Claude', `answered: ${String(ev.text || '').replace(/\s+/g, ' ')}`)]
    case 'pickup':
      return [line(E, it.at, W, `${ev.turn > 1 ? 'resumed' : 'picked up'} · ${String(ev.conversation_id || '').slice(0, 8)}`)]
    case 'burst': {
      const shown = it.tools.slice(-5)
      const out = [line(E, it.at, W, `worked · ${it.tools.length} tool${it.tools.length === 1 ? '' : 's'}${it.errors ? ` · ${it.errors} failed` : ''}`)]
      if (it.tools.length > shown.length) {
        const kinds = [...new Set(it.tools.slice(0, -5).map((t) => toolKind(t.tool)))].join(', ')
        out.push(detail(E, [dim(E, `+ ${it.tools.length - shown.length} earlier · ${kinds}`)], 'mid'))
      }
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
      const s = stateOf(ev.state)
      const ask = ev.state === 'question'
      const out = [ask
        ? line(E, it.at, W, `asks: ${ev.question || ev.summary}`, { color: 'yellow', weight: 'semibold', wrap: 'wrap' })
        : line(E, it.at, W, `${ev.state === 'done' ? 'done' : s.word}: ${m.expanded ? ev.summary : clip(ev.summary, 110)}`, { wrap: 'wrap', color: ev.state === 'done' ? undefined : s.color })]
      if (ev.changed?.length) out.push(detail(E, [dim(E, `changed  ${ev.changed.map((c) => c.trim()).join(', ')}`, { wrap: 'truncate-middle' })]))
      for (const w of (ev.warnings || []).slice(0, m.expanded ? 9 : 2)) out.push(detail(E, [T(E, `! ${m.expanded ? w : shortWarning(w)}`, { color: 'yellow', wrap: m.expanded ? 'wrap' : 'truncate' })]))
      return out
    }
    case 'kill':
      return [line(E, it.at, 'relay', `stopped ${W}: ${ev.reason}${ev.active ? ` (in ${ev.active.tool})` : ''}`, { color: 'red' })]
    case 'gate':
      return [line(E, it.at, 'Claude', `gate ${ev.pass ? 'passed' : 'FAILED'} · ${ev.cmd || ''}`, { color: ev.pass ? 'green' : 'red', wrap: 'truncate-middle' })]
    case 'verdict': {
      const c = { pass: 'green', partial: 'yellow' }[ev.verdict] || 'red'
      const out = [line(E, it.at, ev.role && ev.role !== 'claude' ? 'You' : 'Claude', `rated ${String(ev.verdict).toUpperCase()}`, { color: c, weight: 'semibold' })]
      if (ev.note) out.push(detail(E, [dim(E, ev.note, { wrap: 'wrap' })]))
      return out
    }
    default:
      return []
  }
}

function review(E, items, st, running, m) {
  const rows = items.filter((it) => it.kind === 'gate' || it.kind === 'verdict').flatMap((it) => item(E, it))
  // With auto-benchmarking off nobody rates jobs, so never show a review as pending.
  const waiting = m.benchOn !== false && !running && /^(done|tests_failed)$/.test(st.state) && !m.verdict
  if (!rows.length && !waiting) return []
  const out = [T(E, ' '), section(E, 'review'), ...rows]
  if (waiting) out.push(dim(E, `Awaiting Claude’s review · agent-handoff review ${String(st.id || m.job?.id || '').slice(-4)}`, { wrap: 'truncate' }))
  return out
}

function actions(E, m, st, running) {
  const out = []
  if (!running && st.state === 'question') {
    out.push(T(E, ' '), E.Input({ key: 'answer', label: `Answer ${m.worker || 'agy'}`, placeholder: `Type the answer; ${m.worker || 'agy'} resumes the same conversation`, value: '', submitLabel: 'send', onSubmit: m.actions.answer }))
  }
  const btns = []
  if (running) btns.push(E.Button({ key: 'cancel', label: 'Cancel', hotkey: 'c', onPress: m.actions.cancel }))
  btns.push(E.Button({ key: 'expand', label: m.expanded ? 'Collapse' : 'Expand', hotkey: 'e', plain: true, onPress: m.actions.toggleExpand }))
  btns.push(E.Button({ key: 'older', label: '◀ Older', hotkey: 'o', plain: true, onPress: m.actions.older }))
  btns.push(E.Button({ key: 'newer', label: 'Newer ▶', hotkey: 'n', plain: true, onPress: m.actions.newer }))
  if (!m.following) btns.push(E.Button({ key: 'follow', label: 'Latest', hotkey: 'l', plain: true, onPress: m.actions.follow }))
  out.push(T(E, ' '), row(E, btns, { columnGap: 3 }))
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
    return E.Button({
      key: 'job-' + j.id,
      label: `${j.id} ${s.word}: ${clip(j.task, 60)}`,
      plain: true,
      onPress: () => m.actions.select(j.id),
      children: [
        E.Text({ mono: true, color: s.color, children: [`${s.glyph} ${s.word}`.padEnd(STATE_W)] }),
        E.Text({ mono: true, dimColor: true, children: [`#${j.id.slice(-4)} ${shortModel(j.model).padEnd(MODEL_W)}`] }),
        E.Text({ mono: true, children: [clip(j.task, taskW)] }),
      ],
    })
  })]
}

// The auto-benchmarking switch heads the Bench tab: on, Claude rates every finished
// handoff and the ratings steer routing; off, nothing is rated and routing is fixed.
function autobenchSwitch(E, m) {
  const on = m.benchOn !== false
  return [
    spread(E,
      row(E, [dim(E, 'AUTO-BENCHMARK'), chip(E, on ? 'ON' : 'OFF', on ? 'green' : undefined)]),
      E.Button({ key: 'autobench', label: on ? 'Turn off' : 'Turn on', hotkey: 'a', plain: true, onPress: m.actions.toggleAutobench })),
    dim(E, on
      ? 'Claude reviews and rates every finished handoff; the ratings pick the model next time.'
      : 'Finished handoffs are not rated; each kind of task uses a fixed model.', { wrap: 'wrap' }),
    T(E, ' '),
  ]
}

// Bench as race lanes: models ranked by pass rate, then speed, per kind of task.
function benchTab(E, m, w) {
  const out = autobenchSwitch(E, m)
  if (!m.bench?.length) return [...out, ...empty(E, 'No finished jobs in the ledger yet', 'Pass rates per model appear after the first runs.')]
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
        meter(E, r.rate, 16, c),
        keep(E, T(E, `${pct(r.rate).padStart(4)} pass`, { color: c, weight: 'semibold' })),
      ]))
      out.push(row(E, [fixed(E, 5, T(E, '')), grow(E, [dim(E, [`${r.runs} run${r.runs === 1 ? '' : 's'}`, `${fmtDur(r.medS)} median`, r.medTok ? `${Math.round(r.medTok / 1000)}k tok` : '', `${r.stalls} stalls`, `${r.questions || 0} questions`].filter(Boolean).join(' · '), { wrap: 'truncate' })])]))
    })
    out.push(T(E, ' '))
  }
  out.push(dim(E, `Claude's rating or the test gate counts as a full run; the worker's own "done" counts half.${unverified ? ` ${unverified} run(s) still need a rating.` : ''}`, { wrap: 'wrap' }))
  return out
}
