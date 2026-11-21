// agent-handoff mod: shows each Claude -> worker (agy or Codex) handoff live.
//  - a pane (/handoff) with the live job's handoff timeline, a jobs list and the bench
//  - a band above the prompt while the worker runs or waits on a question
//  - toasts and transcript log lines when the worker picks up, asks, finishes or stalls
//  - auto-benchmarking: asks Claude to review and rate each finished handoff
// It only reads ~/.agent-handoff (written by the agent-handoff CLI); buttons call the CLI.
import { JOB_RE, LIVE, benchRows, clip, parseJsonl, safeJson, shortModel, stateOf, workerOf } from './data.js'
import { band, pane } from './view.js'

const PANE = 'agent-handoff'
const HANDOFF_RE = /\bagent-handoff\s+(run|answer)\b/
const COMMAND = 'handoff'
const TITLE = 'handoff'
// Auto-benchmarking is on unless config.json turns it off (`bench` is the pre-rename key).
const autobenchOf = (c) => (c?.autobench ?? c?.bench) !== false

let home = null
let runtime = null // { node, cli } written by the CLI
let ids = []
let selId = null // null = follow the latest job
let tab = 'live'
let expanded = false // full worker replies and warnings in the timeline
let paneOpen = false
let latest = null // { id, meta, status }
let job = null // { id, meta, status, events }
let jobs = []
let bench = null
let quota = null
let benchOn = true // config.json autobench; off = no reviews are expected
let verdicts = new Set()
let notice = ''
let noticeUntil = 0
const seen = new Map()
let primed = false
let busy = false
let drawn = ''

const file = (id, name) => `${home}/jobs/${id}/${name}`

async function readText($, path) {
  try { return String(await $.fs.read(path)) } catch { return '' }
}

async function readJson($, path) {
  return safeJson(await readText($, path))
}

// A live job whose status hasn't moved for well past the stall limit has lost its relay process.
function effState(st, meta, now) {
  if (LIVE.has(st.state) && st.last_event_at && now - Date.parse(st.last_event_at) > ((meta.stall_s || 240) * 2 + 120) * 1000) return 'orphaned'
  return st.state
}

function showBand(now) {
  if (!latest) return false
  const st = latest.status
  const state = effState(st, latest.meta, now)
  if (LIVE.has(state)) return true
  const since = st.finished ? now - Date.parse(st.finished) : Infinity
  return (state === 'question' && since < 30 * 60e3) || since < 60e3
}

async function refresh($, now) {
  if (!home) return
  let entries = []
  try { entries = await $.fs.list(`${home}/jobs`) } catch { entries = [] }
  ids = entries.map((x) => x.name).filter((n) => JOB_RE.test(n)).sort()
  const lid = ids[ids.length - 1]
  latest = lid ? { id: lid, meta: (await readJson($, file(lid, 'meta.json'))) || {}, status: (await readJson($, file(lid, 'status.json'))) || {} } : null
  if (latest) await announce($, now)
  if (!paneOpen) return

  const id = selId && ids.includes(selId) ? selId : lid
  if (id) {
    const same = latest && id === latest.id
    job = {
      id,
      meta: same ? latest.meta : (await readJson($, file(id, 'meta.json'))) || {},
      status: same ? latest.status : (await readJson($, file(id, 'status.json'))) || {},
      events: parseJsonl(await readText($, file(id, 'events.jsonl'))),
    }
  } else job = null

  const ledger = await readText($, `${home}/ledger.jsonl`)
  verdicts = new Set(parseJsonl(ledger).filter((r) => r.type === 'verdict').map((r) => r.id))
  if (tab === 'bench') bench = benchRows(ledger)
  if (tab === 'jobs') {
    const list = []
    for (const jid of ids.slice(-15).reverse()) {
      const meta = (await readJson($, file(jid, 'meta.json'))) || {}
      const status = (await readJson($, file(jid, 'status.json'))) || {}
      list.push({ id: jid, state: effState(status, meta, now), model: meta.model, kind: meta.kind, task: meta.task })
    }
    jobs = list
  }
  const gq = (await readJson($, `${home}/quota.json`))?.quota
  const cq = (await readJson($, `${home}/codex-quota.json`))?.quota
  quota = gq || cq ? { ...(gq || {}), ...(cq ? { codex5h: cq.codex5h, codexWeek: cq.codexWeek } : {}) } : null
  benchOn = autobenchOf(await readJson($, `${home}/config.json`))
}

// Toast and log when the latest job changes state. Nothing on the first look at startup.
async function announce($, now) {
  const st = effState(latest.status, latest.meta, now)
  const prev = seen.get(latest.id)
  seen.set(latest.id, st)
  if (!primed || prev === st) return
  const s = latest.status
  const tag = `${latest.id} · ${shortModel(latest.meta.model)}`
  const W = workerOf(latest.meta)
  if (st === 'working') {
    $.ui.toast(`${W} picked up the task (${tag})`)
  } else if (st === 'question') {
    $.ui.toast(`${W} asks: ${clip(s.question, 140)}`)
    $.ui.log(`${W} asks (${tag}): ${clip(s.question, 300)}`)
  } else if (st === 'done') {
    const on = autobenchOf(await readJson($, `${home}/config.json`))
    $.ui.toast(on ? `${W} finished ${latest.id}; Claude reviews and rates it next` : `${W} finished ${latest.id}`)
    $.ui.log(`${W} done (${tag}): ${clip(s.summary, 300)}`)
  } else if (st && st !== 'starting') {
    $.ui.toast(`${W} ${stateOf(st).word} (${tag})`)
    $.ui.log(`${W} ${stateOf(st).word} (${tag})${s.summary ? `: ${clip(s.summary, 200)}` : ''}`)
  }
}

// Auto-benchmarking: Claude owns the verdict, and rates every finished handoff without
// being asked. If one still has none 20 s after it finished (say the user answered the
// worker from the pane, so no Claude turn was watching), ask Claude once.
// $.store is shared by every session on the machine. The session that runs
// `agent-handoff run` claims the next job; only that session is asked to review it.
// A job nobody claimed (started from a plain shell, or by a session without this
// mod) is asked of nobody: any session could be the first to look.
const REVIEW_AFTER_MS = 20e3
const nudged = new Set()
let mySession = null
async function nudgeReview($, now) {
  const st = latest?.status
  if (!st || !/^(done|tests_failed)$/.test(st.state) || !st.finished || nudged.has(latest.id)) return
  // Auto-benchmarking off: no verdicts are wanted, so never spend a Claude turn asking for one.
  if (!autobenchOf(await readJson($, `${home}/config.json`))) { nudged.add(latest.id); return }
  const age = now - Date.parse(st.finished)
  if (age < REVIEW_AFTER_MS || age > 24 * 3600e3) return
  nudged.add(latest.id)
  const created = Date.parse(latest.meta.created || st.started)
  const claims = (await $.store.get('claims')) || []
  const owner = claims.filter((c) => c.at <= created + 10e3 && c.at >= created - 10 * 60e3).sort((a, b) => b.at - a.at)[0]
  if (!owner || owner.session !== mySession) return
  const shared = (await $.store.get('nudged')) || []
  if (shared.includes(latest.id)) return
  await $.store.set('nudged', [...shared, latest.id].slice(-50))
  const ledger = await readText($, `${home}/ledger.jsonl`)
  if (parseJsonl(ledger).some((r) => r.type === 'verdict' && r.id === latest.id)) return
  $.prompt.submit({
    text: `Auto-benchmark: agent-handoff job ${latest.id} (${workerOf(latest.meta)}) finished (${st.state}) and has no rating yet. Review it with \`agent-handoff review ${latest.id}\`, then record \`agent-handoff verify ${latest.id} pass|partial|fail --note "<why>"\`. If you have already rated it, ignore this.`,
  }).catch(() => {})
}

async function say($, text) {
  notice = text
  noticeUntil = (await $.clock.now()) + 10e3
}

async function redrawNow($) {
  try { await refresh($, await $.clock.now()) } catch { /* keep the last data */ }
  $.ui.invalidate('ui.render')
}

async function openPane($, t, id) {
  tab = t || 'live'
  if (id !== undefined) selId = id
  paneOpen = true
  await redrawNow($)
  await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
}

async function loadRuntime($) {
  if (!runtime) runtime = await readJson($, `${home}/runtime.json`)
  if (!runtime) await say($, 'Run `agent-handoff setup` once (or ask Claude to) so the pane knows where node and the CLI are.')
  return runtime
}

async function runCli($, args, okText) {
  if (!(await loadRuntime($))) return
  try {
    const r = await $.process.run([runtime.node, runtime.cli, ...args])
    await say($, r.exitCode === 0 ? okText : clip(r.stderr || r.stdout || `exit ${r.exitCode}`, 200))
  } catch (err) {
    await say($, clip(String(err?.message || err), 200))
  }
  await redrawNow($)
}

// The answer resumes the worker's conversation in the background, and Claude hears
// about it so it neither answers again nor loses track of the job.
const lastAnswer = new Map() // id -> time sent; the Input has fired onSubmit twice for one Enter
async function sendAnswer($, id, text) {
  if (!String(text || '').trim()) return
  const now = await $.clock.now()
  if (now - (lastAnswer.get(id) || 0) < 30e3) return
  const st = (await readJson($, file(id, 'status.json'))) || {}
  const W = workerOf((await readJson($, file(id, 'meta.json'))) || {})
  if (st.state !== 'question') { await say($, `${W} isn't waiting on a question for ${id} (${stateOf(st.state).word}).`); return }
  lastAnswer.set(id, now)
  if (!(await loadRuntime($))) return
  try {
    await $.process.run(['/bin/sh', '-c', 'nohup "$0" "$1" answer "$2" "$3" >/dev/null 2>&1 &', runtime.node, runtime.cli, id, text])
  } catch (err) {
    await say($, clip(String(err?.message || err), 200))
    return
  }
  await say($, `Answer sent. ${W} resumes the same conversation.`)
  $.ui.log(`you answered ${W} (${id}): ${clip(text, 300)}`)
  $.prompt.submit({
    text: `The user answered ${W}'s question on agent-handoff job ${id} from the handoff pane: "${text}". The relay has resumed that job in the same ${W} conversation, so do not answer it again. Follow it with \`agent-handoff status ${id}\` and review the result when it finishes.`,
  }).catch(() => {})
  await redrawNow($)
}

// The switch lives in config.json; the CLI writes it so both stay in step.
async function setAutobench($, value) {
  const want = value === 'toggle' ? !benchOn : value === 'on'
  await runCli($, ['config', 'autobench', want ? 'on' : 'off'],
    want ? 'Auto-benchmarking on: Claude reviews and rates every finished handoff.' : 'Auto-benchmarking off: finished handoffs are not rated.')
  // refresh() skips config while the pane is closed; read it so /handoff reports the new value.
  benchOn = autobenchOf(await readJson($, `${home}/config.json`))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const custom = await $.env.get('AGENT_HANDOFF_HOME')
      home = custom || `${await $.env.get('HOME')}/.agent-handoff`
      runtime = await readJson($, `${home}/runtime.json`)
      mySession = await $.session.id()
      await refresh($, await $.clock.now())
    } catch { /* no jobs yet */ }
    primed = true
    $.clock.every(1000, async () => {
      if (busy) return
      busy = true
      try {
        const now = await $.clock.now()
        await refresh($, now)
        await nudgeReview($, now)
        const sig = JSON.stringify([latest?.id, latest?.status?.state, latest?.status?.last_event_at, job?.id, job?.events?.length, tab, notice, bench?.length, jobs.length, quota?.gemini5h, quota?.codexWeek, benchOn])
        const live = latest && LIVE.has(latest.status.state)
        if (sig !== drawn || live || (notice && now > noticeUntil)) {
          drawn = sig
          $.ui.invalidate('ui.render')
        }
      } catch { /* try again next second */ } finally {
        busy = false
      }
    })
    try {
      await $.command.register({ name: COMMAND, description: 'Watch Claude Code handoffs to agy or Codex: live job, jobs, bench; switch auto-benchmarking', argumentHint: '[live|jobs|bench|autobench on|off|<job id>]', immediate: true })
    } catch { /* name taken */ }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = String(e.args || '').trim()
    const ab = /^auto-?bench(?:\s+(on|off|toggle))?$/i.exec(arg)
    if (ab) {
      if (ab[1]) await setAutobench($, ab[1].toLowerCase())
      else await openPane($, 'bench')
      return { text: `Auto-benchmarking is ${benchOn ? 'on: Claude reviews and rates every finished handoff' : 'off: finished handoffs are not rated'}.` }
    }
    if (arg === 'jobs' || arg === 'bench') await openPane($, arg)
    else if (arg && arg !== 'live') {
      const hit = ids.filter((id) => id === arg || id.endsWith(arg) || id.startsWith(arg))
      if (hit.length !== 1) return { text: hit.length ? `More than one job matches ${arg}.` : `No agent-handoff job ${arg}.` }
      await openPane($, 'live', hit[0])
    } else await openPane($, 'live', null)
    return {}
  })

  // These two only watch, so if one fails the event carries on unchanged.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  }).catch(async ($, e, next) => next(e))

  // Claude handing off: follow the new job and open the pane beside the transcript.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const m = HANDOFF_RE.exec(String(e.command || ''))
    if (m) {
      selId = null
      tab = 'live'
      if (m[1] === 'run') {
        const claims = (await $.store.get('claims')) || []
        await $.store.set('claims', [...claims, { session: mySession, at: await $.clock.now() }].slice(-20))
      }
      const to = /--backend[= ](agy|codex)\b/.exec(String(e.command || ''))?.[1] || 'a worker'
      $.ui.toast(m[1] === 'run' ? `Claude is handing a task to ${to}` : 'Claude is answering the worker')
      if (m[1] === 'run' && !paneOpen) {
        paneOpen = true
        try { await $.ui.open({ id: PANE, title: TITLE }) } catch { paneOpen = false }
      }
    }
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    if (!showBand(now)) return next(e)
    const E = $.ui.resolve(e)
    const mine = band(E, { latest, latestState: effState(latest.status, latest.meta, now), now, actions: { open: () => openPane($, 'live', null) } })
    const theirs = await next(e)
    return theirs ? E.Box({ flexDirection: 'column', children: [mine, theirs] }) : mine
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const E = $.ui.resolve(e)
    const now = await $.clock.now()
    if (notice && now > noticeUntil) notice = ''
    const pos = job ? ids.indexOf(job.id) : -1
    return pane(E, {
      tab, job, jobs, bench, quota, now, notice, expanded, cols: e.props?.bodyColumns,
      following: !selId,
      jobState: job ? effState(job.status, job.meta, now) : null,
      verdict: job ? verdicts.has(job.id) : false,
      benchOn,
      svgOk: e.surface === 'desktop' || e.surface === 'vscode',
      actions: {
        setTab: (t) => { tab = t; redrawNow($) },
        select: (id) => { selId = id; tab = 'live'; redrawNow($) },
        older: () => { if (pos > 0) { selId = ids[pos - 1]; redrawNow($) } },
        newer: () => { if (pos >= 0 && pos < ids.length - 1) { selId = pos + 1 === ids.length - 1 ? null : ids[pos + 1]; redrawNow($) } },
        follow: () => { selId = null; redrawNow($) },
        toggleExpand: () => { expanded = !expanded; $.ui.invalidate('ui.render') },
        answer: (text) => sendAnswer($, job.id, text),
        cancel: () => runCli($, ['cancel', job.id], `Cancel sent to ${job.id}.`),
        toggleAutobench: () => setAutobench($, benchOn ? 'off' : 'on'),
      },
    })
  })
}
