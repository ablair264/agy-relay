// Element trees for the agent-handoff pane and the band above the prompt.
// Takes the elements from $.ui.resolve(e) and plain data; never the mods API.
// Style: monospace throughout, small uppercase section labels, straight rules,
// no bordered boxes. Every Text is mono so padded columns line up in Desktop too.
import {
  AGY, CLAUDE, CODEX, LADDER, LIVE, MODELS, OVERFLOW, STATE, WORKERS, activitySvg, clip, fmtDur, fmtTok, idleBar, pct, shortModel, stateOf, timeline, toolKind, workerColor, workerOf,
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
  if (LIVE.has(st.state)) return st.active ? `${st.active.tool} ${st.active.arg || ''}` : st.state === 'starting' ? 'starting up' : 'thinking'
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

export function pane(E, m) {
  const w = Math.max(30, (m.cols || 64) - 2)
  const tab = (id, text, hotkey) => E.Button({ key: 'tab-' + id, label: text, hotkey, plain: true, dimColor: m.tab !== id, onPress: () => m.actions.setTab(id) })
  // Groups are separated by space, not lines: title + tabs, quota, notice, body.
  const kids = [
    spread(E, label(E, 'handoff'), dim(E, m.job ? `${m.job.id} · ${shortModel(m.job.meta.model)}` : '')),
    row(E, [tab('live', 'LIVE', '1'), tab('jobs', 'JOBS', '2'), tab('bench', 'BENCH', '3'), tab('settings', 'SETTINGS', '4')], { columnGap: 3 }),
  ]
  if (m.quota) kids.push(T(E, ' '), ...quotaMeters(E, m.quota))
  if (m.notice) kids.push(T(E, ' '), T(E, m.notice, { color: 'yellow', wrap: 'wrap' }))
  kids.push(T(E, ' '))
  const body = m.tab === 'jobs' ? jobsTab(E, m) : m.tab === 'bench' ? benchTab(E, m, w) : m.tab === 'settings' ? settingsTab(E, m, w) : liveTab(E, m, w)
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
    ...activeList(E, m, w),
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

// Every active job at a glance, above the timeline, whenever more than one is going
// (or one is going while you look at another). ▸ marks the job whose timeline is
// below; select a row to show that one instead.
function activeList(E, m, w) {
  const act = m.active || []
  if (!act.some((a) => a.id !== m.job?.id)) return []
  const doingW = Math.max(8, w - 2 - STATE_W - 6 - MODEL_W - 9 - 4)
  const rows = act.map((a) => {
    const s = stateOf(a.state)
    const W = workerOf(a.meta)
    const st = a.status
    const shown = a.id === m.job?.id
    const right = LIVE.has(a.state) && st.started ? fmtDur((m.now - Date.parse(st.started)) / 1000)
      : a.state === 'queued' ? `#${st.position || 1}` : a.state === 'question' ? 'waiting' : ''
    return E.Button({
      key: 'active-' + a.id,
      label: `${W} ${s.word}: ${clip(a.meta.task, 60)}`,
      plain: true,
      onPress: () => m.actions.select(a.id),
      children: [
        E.Text({ mono: true, weight: shown ? 'semibold' : undefined, children: [shown ? '▸' : ' '] }),
        E.Text({ mono: true, color: s.color, children: [`${s.glyph} ${s.word}`.padEnd(STATE_W)] }),
        E.Text({ mono: true, color: workerColor(W), weight: 'semibold', children: [W.padEnd(6)] }),
        E.Text({ mono: true, dimColor: true, children: [shortModel(a.meta.model).padEnd(MODEL_W)] }),
        E.Text({ mono: true, children: [clip(doingOf(st), doingW).padEnd(doingW)] }),
        E.Text({ mono: true, dimColor: true, children: [right.padStart(8)] }),
      ],
    })
  })
  return [section(E, `active · ${act.length}`), ...rows, T(E, ' ')]
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
    const models = MODELS[wk].filter((id) => id !== cur && !s.disabled.has(id))
    if (!models.length) continue
    any = true
    out.push(label(E, wk, workerColor(wk)))
    for (const id of models) {
      out.push(E.Button({
        key: 'pick-' + id,
        label: `${going ? 'Restart' : 'Rerun'} on ${shortModel(id)}`,
        plain: true,
        onPress: () => m.actions.rerunOn(id),
        children: [
          E.Text({ mono: true, children: [`  ${shortModel(id).padEnd(MODEL_W)}`] }),
          E.Text({ mono: true, dimColor: true, children: [modelNote(wk, id)] }),
        ],
      }))
    }
  }
  if (!any) out.push(...empty(E, 'No other model is turned on', 'Turn more on in the Settings tab (4).'))
  const hidden = order.reduce((n, wk) => n + (s.workers[wk] ? MODELS[wk].filter((id) => s.disabled.has(id)).length : MODELS[wk].length), 0)
  if (hidden) out.push(dim(E, `${hidden} model${hidden === 1 ? ' is' : 's are'} turned off in Settings (4) and not listed.`, { wrap: 'wrap' }))
  out.push(dim(E, `Now on ${shortModel(cur)}. ${going ? 'The current run stops first; ' : ''}the rerun is a new job, and Claude reviews it.`, { wrap: 'wrap' }))
  return out
}

const modelNote = (wk, id) => (OVERFLOW.has(id) ? 'overflow · own weekly pool' : `rung ${MODELS[wk].indexOf(id) + 1}${id === 'gemini-4-hydrogen-low' ? ' · lookups and digests' : ''}`)

// A section heading with a note at the right end of its rule.
const sectionNote = (E, text, note) => row(E, [keep(E, dim(E, `── ${text.toUpperCase()}`)), ruleFill(E), keep(E, dim(E, note))])

// Settings: which workers and models routing may use, the default worker, the
// usage cut-offs and auto-benchmarking. Each press runs `agent-handoff config`.
function settingsTab(E, m, w) {
  const s = m.settings
  const a = m.actions
  const out = [section(E, 'workers')]
  for (const wk of ['agy', 'codex']) {
    const on = s.workers[wk]
    out.push(spread(E,
      row(E, [fixed(E, 6, label(E, wk, workerColor(wk))), keep(E, chip(E, on ? 'ON' : 'OFF', on ? 'green' : 'gray')), dim(E, WORKERS[wk], { wrap: 'truncate' })]),
      E.Button({ key: 'worker-' + wk, label: on ? 'Turn off' : 'Turn on', plain: true, onPress: () => a.toggleWorker(wk) })))
  }
  if (!s.workers.agy && !s.workers.codex) out.push(T(E, '! Both workers are off, so handoffs will fail until one is on.', { color: 'yellow', wrap: 'wrap' }))

  out.push(T(E, ' '), section(E, 'default worker'))
  out.push(row(E, ['auto', 'agy', 'codex'].map((b) => E.Button({
    key: 'backend-' + b, label: `${s.backend === b ? '●' : '○'} ${b}`, plain: true, dimColor: s.backend !== b || undefined, onPress: () => a.setBackend(b),
  })), { columnGap: 3 }))
  out.push(dim(E, s.backend === 'auto'
    ? 'Picks a worker for each task from usage left and pass rates.'
    : `Every handoff goes to ${s.backend} unless Claude or a command names the other.`, { wrap: 'wrap' }))

  for (const wk of ['agy', 'codex']) {
    const list = MODELS[wk]
    const onCount = list.filter((id) => !s.disabled.has(id)).length
    const workerOff = !s.workers[wk]
    out.push(T(E, ' '), sectionNote(E, `${wk} models`, workerOff ? 'worker off' : `${onCount} of ${list.length} on`))
    for (const id of list) {
      const on = !s.disabled.has(id)
      out.push(E.Button({
        key: 'model-' + id,
        label: `${on ? 'Turn off' : 'Turn on'} ${shortModel(id)}`,
        plain: true,
        onPress: () => a.toggleModel(id),
        children: [
          E.Text({ mono: true, color: on && !workerOff ? 'green' : undefined, dimColor: !on || workerOff || undefined, children: [on ? '✓' : '·'] }),
          E.Text({ mono: true, dimColor: !on || workerOff || undefined, strikethrough: !on || undefined, children: [shortModel(id).padEnd(MODEL_W)] }),
          E.Text({ mono: true, dimColor: true, children: [modelNote(wk, id)] }),
        ],
      }))
    }
    if (!workerOff && !list.some((id) => !OVERFLOW.has(id) && !s.disabled.has(id))) out.push(T(E, `! Every ${wk} ladder model is off, so ${wk} won't be used.`, { color: 'yellow', wrap: 'wrap' }))
  }

  out.push(T(E, ' '), section(E, 'usage cut-offs'))
  const limitRow = (which, text, value) => row(E, [
    fixed(E, 30, T(E, text, { wrap: 'truncate' })),
    E.Button({ key: which + '-down', label: '−', plain: true, onPress: () => a.stepLimit(which, -5) }),
    fixed(E, 5, T(E, value ? `${Math.round(value * 100)}%`.padStart(4) : ' off', { weight: 'semibold', color: value ? undefined : 'gray' })),
    E.Button({ key: which + '-up', label: '+', plain: true, onPress: () => a.stepLimit(which, 5) }),
  ], { columnGap: 2 })
  out.push(limitRow('low', 'Prefer the other worker below', s.limits.low))
  out.push(limitRow('stop', 'Never use a worker below', s.limits.stop))
  out.push(dim(E, 'Usage left in the tighter of the 5-hour and weekly windows (the meters at the top). Under the first, the other worker is picked if it has more. Under the second, a worker is not used at all.', { wrap: 'wrap' }))

  out.push(T(E, ' '), ...autobenchSwitch(E, m))
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
