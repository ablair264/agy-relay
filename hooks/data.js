// Pure helpers for the agent-handoff mod: no mods API, no Node APIs.

export const JOB_RE = /^\d{8}-[a-z0-9]{4}$/

export const LADDER = [
  'gemini-4-hydrogen-low', 'gemini-4-neon-low', 'gemini-4-hydrogen-high',
  'gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-neon-xhigh',
  'gemini-4-argon-medium', 'gemini-4-argon-high',
  // retired: kept so old ledger rows still sort
  'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-4-argon-low',
  'gpt-6-luna:low', 'gpt-6-luna:medium', 'gpt-6.1-sol:low', 'gpt-6.1-sol:medium', 'gpt-6.1-sol:high', 'gpt-6-astra:medium',
]

export const LIVE = new Set(['starting', 'working'])

export const STATE = {
  queued: { glyph: '◌', color: 'gray', word: 'queued' },
  starting: { glyph: '○', color: 'blue', word: 'starting' },
  working: { glyph: '●', color: 'blue', word: 'working' },
  done: { glyph: '✓', color: 'green', word: 'done' },
  question: { glyph: '?', color: 'yellow', word: 'asking you' },
  blocked: { glyph: '■', color: 'yellow', word: 'blocked' },
  stalled: { glyph: '✕', color: 'red', word: 'stalled' },
  stalled_startup: { glyph: '✕', color: 'red', word: 'never started' },
  looping: { glyph: '↻', color: 'red', word: 'looping' },
  timeout: { glyph: '✕', color: 'red', word: 'timed out' },
  failed: { glyph: '✕', color: 'red', word: 'failed' },
  tests_failed: { glyph: '✕', color: 'red', word: 'gate failed' },
  cancelled: { glyph: '–', color: 'gray', word: 'cancelled' },
  limited: { glyph: '⏸', color: 'yellow', word: 'usage limit' },
  orphaned: { glyph: '!', color: 'yellow', word: 'orphaned' },
}
export const stateOf = (s) => STATE[s] || { glyph: '·', color: 'gray', word: s || 'unknown' }

export const CLAUDE = '#d97757'
export const AGY = '#4c8df6'
export const CODEX = '#10a37f'
export const workerColor = (w) => (w === 'codex' ? CODEX : AGY)

// gemini-4-hydrogen-high -> Hydrogen high; gpt-6.1-sol:medium -> Sol 6.1 medium
export const shortModel = (m = '') => {
  const g = m.match(/^gpt-([\d.]+)-([a-z]+)(?::(\w+))?$/)
  if (g) return `${g[2][0].toUpperCase()}${g[2].slice(1)} ${g[1]}${g[3] ? ` ${g[3]}` : ''}`
  const f = m.match(/^gemini-4-([a-z]+)-(\w+)$/)
  if (f) return `${f[1][0].toUpperCase()}${f[1].slice(1)} ${f[2]}`
  return m.replace('gemini-3.8-flash-', 'Flash ')
}
// The worker's display name for a job (old jobs have no backend field: agy).
export const workerOf = (meta) => (meta && meta.backend) || 'agy'

export function fmtDur(s) {
  if (s === null || s === undefined || Number.isNaN(s)) return '-'
  s = Math.max(0, Math.round(s))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export const fmtTok = (n) => (n ? `${Math.round(n / 1000)}k tok` : '')
export const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`)
export const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

export function parseJsonl(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* partial last line while the relay writes */ }
  }
  return out
}

export function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

export const toolKind = (t = '') =>
  /write|replace|edit|sed_file|notebook_edit/.test(t) ? 'write'
    : /run_command|command_status|send_command/.test(t) ? 'shell'
      : /search_web|read_url|browser/.test(t) ? 'web' : 'read'

// Fold events into timeline items: Claude's handoffs and checks, agy's work
// bursts (consecutive tool calls) and replies.
export function timeline(events) {
  const items = []
  const t0 = events.length ? Date.parse(events[0].ts) : 0
  let burst = null
  for (const ev of events) {
    const at = (Date.parse(ev.ts) - t0) / 1000
    if (ev.type === 'tool') {
      if (ev.state === 'start') continue
      if (!burst) { burst = { kind: 'burst', at, turn: ev.turn, tools: [], errors: 0 }; items.push(burst) }
      burst.tools.push(ev)
      if (ev.state === 'error') burst.errors++
      continue
    }
    burst = null
    if (ev.type === 'handoff') items.push({ kind: ev.mode === 'answer' ? 'answer' : 'brief', at, ev })
    else if (ev.type === 'pickup') items.push({ kind: 'pickup', at, ev })
    else if (ev.type === 'reply') items.push({ kind: 'reply', at, ev })
    else if (ev.type === 'kill') items.push({ kind: 'kill', at, ev })
    else if (ev.type === 'gate') items.push({ kind: 'gate', at, ev })
    else if (ev.type === 'verdict') items.push({ kind: 'verdict', at, ev })
    else if (ev.type === 'final') items.push({ kind: 'final', at, ev })
  }
  return items
}

// Mirrors lib/route.mjs scoring: verdict or gate = full weight, agy's own "done" = half.
export function benchRows(ledgerText) {
  const byId = new Map()
  for (const row of parseJsonl(ledgerText)) {
    const cur = byId.get(row.id) || {}
    if (row.type === 'verdict') byId.set(row.id, { ...cur, verdict: row.verdict })
    else byId.set(row.id, { ...cur, ...row, verdict: cur.verdict })
  }
  const agg = new Map()
  for (const r of byId.values()) {
    if (r.type !== 'run' || r.state === 'cancelled' || r.state === 'stalled_startup') continue
    const sc = r.verdict ? { s: { pass: 1, partial: 0.5 }[r.verdict] ?? 0, w: 1 }
      : typeof r.tests_pass === 'boolean' ? { s: r.tests_pass ? 1 : 0, w: 1 }
        : { s: r.state === 'done' ? 1 : 0, w: 0.5 }
    const k = `${r.kind}|${r.model}`
    const o = agg.get(k) || { kind: r.kind, model: r.model, runs: 0, n: 0, ok: 0, secs: [], toks: [], stalls: 0, unverified: 0, questions: 0 }
    o.runs++; o.n += sc.w; o.ok += sc.s * sc.w; o.questions += r.questions || 0
    if (r.duration_s) o.secs.push(r.duration_s)
    if (r.tokens?.total) o.toks.push(r.tokens.total)
    if (/stall|loop|timeout/.test(r.state)) o.stalls++
    if (!r.verdict && typeof r.tests_pass !== 'boolean') o.unverified++
    agg.set(k, o)
  }
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
  return [...agg.values()]
    .map((o) => ({ ...o, rate: o.n ? o.ok / o.n : null, medS: med(o.secs), medTok: med(o.toks) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || LADDER.indexOf(a.model) - LADDER.indexOf(b.model))
}

const SVG_COLORS = { read: '#5b8def', write: '#2f9e6b', shell: '#8b5cf6', web: '#0e9aa7' }

// Activity strip for apps that draw Svg: tool calls on a time axis, with
// Claude's handoffs and agy's replies as ticks.
export function activitySvg(events, nowMs, running) {
  if (!events.length) return null
  // A thin race lane: a track line, tool calls as short ticks on it, handoffs
  // and replies as taller marks, and a head marker at "now" while running.
  const W = 600, H = 22, Y = 11
  const t0 = Date.parse(events[0].ts)
  const tEnd = Math.max(running ? nowMs : Date.parse(events[events.length - 1].ts), t0 + 1000)
  const x = (ms) => ((ms - t0) / (tEnd - t0)) * (W - 8) + 4
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<line x1="4" y1="${Y}" x2="${W - 4}" y2="${Y}" stroke="${running ? AGY : '#8886'}" stroke-width="2"/>`]
  for (const ev of events) {
    const at = Date.parse(ev.ts)
    const X = x(at).toFixed(1)
    if (ev.type === 'tool' && ev.state !== 'start') {
      const start = at - (ev.dur || 0) * 1000
      const fill = ev.state === 'error' ? (ev.hook ? '#d9a400' : '#d64545') : SVG_COLORS[toolKind(ev.tool)]
      parts.push(`<rect x="${x(start).toFixed(1)}" y="${Y - 4}" width="${Math.max(2, x(at) - x(start)).toFixed(1)}" height="8" fill="${fill}"><title>${esc(ev.tool)} ${esc(ev.arg || '')}</title></rect>`)
    } else if (ev.type === 'handoff') {
      parts.push(`<rect x="${X}" y="2" width="2" height="18" fill="${CLAUDE}"><title>Claude ${ev.mode === 'answer' ? 'answered' : 'handed off'}</title></rect>`)
    } else if (ev.type === 'reply') {
      const c = ev.state === 'question' ? '#d9a400' : ev.state === 'done' ? '#2f9e6b' : '#d64545'
      parts.push(`<rect x="${X}" y="2" width="2" height="18" fill="${c}"><title>agy ${esc(ev.state)}</title></rect>`)
    } else if (ev.type === 'kill') {
      parts.push(`<rect x="${X}" y="2" width="2" height="18" fill="#d64545"><title>stopped: ${esc(ev.reason)}</title></rect>`)
    } else if (ev.type === 'gate') {
      parts.push(`<rect x="${(x(at) - 4).toFixed(1)}" y="${Y - 4}" width="8" height="8" fill="${ev.pass ? '#2f9e6b' : '#d64545'}"><title>gate ${ev.pass ? 'pass' : 'fail'}</title></rect>`)
    }
  }
  if (running) parts.push(`<rect x="${(x(nowMs) - 3).toFixed(1)}" y="${Y - 6}" width="6" height="12" fill="${AGY}"/>`)
  parts.push('</svg>')
  return parts.join('')
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// The same bar as an SVG, for apps with a proportional font.
export function idleSvg(idleS, limitS) {
  const f = Math.max(0, Math.min(1, limitS ? idleS / limitS : 0))
  const c = f > 0.8 ? '#d64545' : f > 0.5 ? '#d9a400' : '#2f9e6b'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 8" width="160" height="8"><rect width="160" height="8" rx="4" fill="#8883"/><rect width="${Math.max(4, f * 160).toFixed(1)}" height="8" rx="4" fill="${c}"/></svg>`
}

// A text bar for idle time against the stall limit.
export function idleBar(idleS, limitS, width = 16) {
  const f = Math.max(0, Math.min(1, limitS ? idleS / limitS : 0))
  const full = Math.round(f * width)
  return { bar: '█'.repeat(full) + '░'.repeat(width - full), color: f > 0.8 ? 'red' : f > 0.5 ? 'yellow' : 'green' }
}
