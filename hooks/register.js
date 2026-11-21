// agent-handoff mod: shows each Claude -> worker (agy or Codex) handoff live.
//  - a pane (/handoff) with the live job's handoff timeline, a jobs list and the bench
//  - a band above the prompt while the worker runs or waits on a question
//  - toasts and transcript log lines when the worker picks up, asks, finishes or stalls
//  - auto-benchmarking: asks Claude to review and rate each finished handoff
// It only reads ~/.agent-handoff (written by the agent-handoff CLI); buttons call the CLI.
import { JOB_RE, LIVE, benchRows, clip, familyName, newModels, parseJsonl, safeJson, settingsOf, shortModel, stateOf, workerOf } from './data.js'
import { bands, pane } from './view.js'

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
let latest = null // newest job: { id, meta, status, state }
let recent = [] // the newest RECENT jobs, oldest first, same shape
const RECENT = 8
let job = null // { id, meta, status, events }
let jobs = []
let bench = null
let quota = null
let benchOn = true // config.json autobench; off = no reviews are expected
let cfg = {} // config.json as the CLI wrote it (the Settings tab edits it through the CLI)
let picking = false // the Change model list is open under the live job
let offered = {} // { agy: [ids], codex: [ids] }: what each worker lists, from the CLI's model caches
let offeredAt = 0
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

// A job is "active" while it runs, waits in the queue or waits on an answer, and
// for a minute after it ends, so a finish doesn't vanish before anyone sees it.
function isActive(j, now) {
  if (LIVE.has(j.state) || j.state === 'queued') return true
  const since = j.status.finished ? now - Date.parse(j.status.finished) : Infinity
  return (/^(question|blocked)$/.test(j.state) && since < 30 * 60e3) || since < 60e3
}
const activeJobs = (now) => recent.filter((j) => isActive(j, now))

async function refresh($, now) {
  if (!home) return
  let entries = []
  try { entries = await $.fs.list(`${home}/jobs`) } catch { entries = [] }
  ids = entries.map((x) => x.name).filter((n) => JOB_RE.test(n)).sort()
  // Every recent job, not just the newest: a codex and an agy job can run side by side,
  // and jobs from other sessions land here too.
  const list = []
  for (const id of ids.slice(-RECENT)) {
    const meta = (await readJson($, file(id, 'meta.json'))) || {}
    const status = (await readJson($, file(id, 'status.json'))) || {}
    list.push({ id, meta, status, state: effState(status, meta, now) })
  }
  recent = list
  latest = list[list.length - 1] || null
  cfg = (await readJson($, `${home}/config.json`)) || {}
  const on = autobenchOf(cfg)
  benchOn = on
  // What each worker offers comes from the CLI's caches of `agy models` and
  // `codex debug models` (refreshed daily by routing, or by `agent-handoff models`).
  if (now - offeredAt > 60e3) {
    offeredAt = now
    const ids = async (f) => ((await readJson($, `${home}/${f}`))?.models || []).map((x) => x.id).filter(Boolean)
    offered = { agy: await ids('models.json'), codex: await ids('codex-models.json') }
    await announceNewModels($)
  }
  for (const j of recent) await announce($, j, on)
  if (!paneOpen) return

  const id = selId && ids.includes(selId) ? selId : latest?.id
  if (id) {
    const known = recent.find((j) => j.id === id)
    job = {
      id,
      meta: known ? known.meta : (await readJson($, file(id, 'meta.json'))) || {},
      status: known ? known.status : (await readJson($, file(id, 'status.json'))) || {},
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
}

// Toast and log when any recent job changes state. Nothing on the first look at startup.
async function announce($, j, autobench) {
  const st = j.state
  const prev = seen.get(j.id)
  seen.set(j.id, st)
  if (!primed || prev === st) return
  const s = j.status
  const tag = `${j.id} · ${shortModel(j.meta.model)}`
  const W = workerOf(j.meta)
  if (st === 'working') {
    $.ui.toast(`${W} picked up the task (${tag})`)
  } else if (st === 'question') {
    $.ui.toast(`${W} asks: ${clip(s.question, 140)}`)
    $.ui.log(`${W} asks (${tag}): ${clip(s.question, 300)}`)
  } else if (st === 'done') {
    $.ui.toast(autobench ? `${W} finished ${j.id}; Claude reviews and rates it next` : `${W} finished ${j.id}`)
    $.ui.log(`${W} done (${tag}): ${clip(s.summary, 300)}`)
  } else if (st && st !== 'starting' && st !== 'queued') {
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
  const due = recent.filter((j) => /^(done|tests_failed)$/.test(j.status.state) && j.status.finished && !nudged.has(j.id))
  if (!due.length) return
  // Auto-benchmarking off: no verdicts are wanted, so never spend a Claude turn asking for one.
  if (!benchOn) { for (const j of due) nudged.add(j.id); return }
  for (const j of due) await nudgeOne($, j, now)
}

async function nudgeOne($, j, now) {
  const st = j.status
  const age = now - Date.parse(st.finished)
  if (age < REVIEW_AFTER_MS || age > 24 * 3600e3) return
  nudged.add(j.id)
  const created = Date.parse(j.meta.created || st.started)
  const claims = (await $.store.get('claims')) || []
  const owner = claims.filter((c) => c.at <= created + 10e3 && c.at >= created - 10 * 60e3).sort((a, b) => b.at - a.at)[0]
  if (!owner || owner.session !== mySession) return
  const shared = (await $.store.get('nudged')) || []
  if (shared.includes(j.id)) return
  await $.store.set('nudged', [...shared, j.id].slice(-50))
  const ledger = await readText($, `${home}/ledger.jsonl`)
  if (parseJsonl(ledger).some((r) => r.type === 'verdict' && r.id === j.id)) return
  $.prompt.submit({
    text: `Auto-benchmark: agent-handoff job ${j.id} (${workerOf(j.meta)}) finished (${st.state}) and has no rating yet. Review it with \`agent-handoff review ${j.id}\`, then record \`agent-handoff verify ${j.id} pass|partial|fail --note "<why>"\`. If you have already rated it, ignore this.`,
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
  const jm = (await readJson($, file(id, 'meta.json'))) || {}
  const W = workerOf(jm)
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
  if (!jm.demo) tellClaude($, {
    text: `The user answered ${W}'s question on agent-handoff job ${id} from the handoff pane: "${text}". The relay has resumed that job in the same ${W} conversation, so do not answer it again. Follow it with \`agent-handoff status ${id}\` and review the result when it finishes.`,
  })
  await redrawNow($)
}

// A toast, once per model family on this machine, when a worker starts offering a
// model no ladder knows. The Settings tab lists it with Ask Claude and Dismiss.
async function announceNewModels($) {
  const news = newModels(offered, settingsOf(cfg))
  if (!news.length) return
  const told = (await $.store.get('toldModels')) || []
  const fresh = news.filter((n) => !told.includes(n.family))
  if (!fresh.length) return
  await $.store.set('toldModels', [...told, ...fresh.map((n) => n.family)].slice(-50))
  for (const n of fresh) $.ui.toast(`${n.worker} now offers ${familyName(n.family)}, which isn't on its ladder. See /handoff settings.`)
}

// Ask Claude where a new model fits; nothing changes until the user agrees.
function askAboutModel($, n) {
  tellClaude($, { text: `agent-handoff: ${n.worker} now offers ${n.family}${n.efforts.length ? ` (efforts: ${n.efforts.join(', ')})` : ''}, which isn't on its model ladder. Look up how it compares with the current ${n.worker} ladder (\`agent-handoff config\` shows it) on price and agentic coding benchmarks, and suggest where it fits. The ladder runs cheapest first, one model per rung${n.worker === 'codex' ? ', with ids written model:effort' : ''}. Don't change anything until I agree; then apply it with \`agent-handoff config ladder ${n.worker} <id> <id> …\`. To hide it instead: \`agent-handoff config ignore ${n.family}\`.` })
}

// Claude needs to hear about what the user does in the pane, or it would answer,
// restart or wait on a job that has moved on. Demo jobs stay quiet (screenshots).
function tellClaude($, msg) {
  $.prompt.submit(msg).catch(() => {})
}

// Stop: end the run (or drop it from the queue). Claude's waiting `run` exits as
// cancelled, so say it was the user, or Claude might start it again.
async function stopJob($, id) {
  const jm = (await readJson($, file(id, 'meta.json'))) || {}
  await runCli($, ['cancel', id], `Stopped ${id}.`)
  if (!jm.demo) {
    tellClaude($, { text: `The user stopped agent-handoff job ${id} (${workerOf(jm)}) from the handoff pane. Don't restart it unless they ask; if you were waiting on it, tell them it was stopped.` })
  }
}

// Change model: stop the job if it is still going, then run the same task on the
// model picked. The rerun is a new job, which the pane then follows.
async function rerunOn($, id, model) {
  picking = false
  if (!(await loadRuntime($))) return
  const jm = (await readJson($, file(id, 'meta.json'))) || {}
  const st = (await readJson($, file(id, 'status.json'))) || {}
  const wasRunning = LIVE.has(st.state) || st.state === 'queued'
  try {
    await $.process.run(['/bin/sh', '-c', 'nohup "$0" "$1" retry "$2" --model "$3" >/dev/null 2>&1 &', runtime.node, runtime.cli, id, model])
  } catch (err) {
    await say($, clip(String(err?.message || err), 200))
    return
  }
  // This session started the rerun, so it reviews it.
  const claims = (await $.store.get('claims')) || []
  await $.store.set('claims', [...claims, { session: mySession, at: await $.clock.now() }].slice(-20))
  selId = null
  await say($, `${wasRunning ? 'Stopping and restarting' : 'Rerunning'} on ${shortModel(model)}…`)
  $.ui.log(`you moved ${id} to ${model}`)
  if (!jm.demo) {
    tellClaude($, { text: `The user ${wasRunning ? 'stopped' : 'reran'} agent-handoff job ${id} from the handoff pane and restarted the same task on ${model}. The rerun is now the newest job: follow it with \`agent-handoff status\`, then review and rate it when it finishes. Don't start it again yourself.` })
  }
  await redrawNow($)
}

// Settings tab: every change goes through `agent-handoff config` so the CLI validates it.
const pctOf = (x) => Math.round((x || 0) * 100)
async function setting($, args, okText) {
  await runCli($, ['config', ...args], okText)
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
        const sig = JSON.stringify([recent.map((j) => [j.id, j.state, j.status.last_event_at]), job?.id, job?.events?.length, tab, notice, bench?.length, jobs.length, quota?.gemini5h, quota?.codexWeek, benchOn, cfg, offered])
        const live = recent.some((j) => LIVE.has(j.status.state))
        if (sig !== drawn || live || (notice && now > noticeUntil)) {
          drawn = sig
          $.ui.invalidate('ui.render')
        }
      } catch { /* try again next second */ } finally {
        busy = false
      }
    })
    try {
      await $.command.register({ name: COMMAND, description: 'Watch Claude Code handoffs to agy or Codex: live jobs, history, bench and settings', argumentHint: '[live|jobs|bench|settings|autobench on|off|<job id>]', immediate: true })
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
    if (arg === 'jobs' || arg === 'bench' || arg === 'settings') await openPane($, arg)
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
    const act = activeJobs(now)
    if (!act.length) return next(e)
    const E = $.ui.resolve(e)
    // One row per active job; Open follows the newest job, or pins the one clicked.
    const mine = bands(E, { jobs: act, now, maxRows: e.props?.maxRows, open: (id) => openPane($, 'live', id === latest?.id ? null : id) })
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
      settings: settingsOf(cfg), picking: picking && !!job, newModels: newModels(offered, settingsOf(cfg)),
      active: activeJobs(now),
      following: !selId,
      jobState: job ? effState(job.status, job.meta, now) : null,
      verdict: job ? verdicts.has(job.id) : false,
      benchOn,
      svgOk: e.surface === 'desktop' || e.surface === 'vscode',
      actions: {
        setTab: (t) => { tab = t; redrawNow($) },
        select: (id) => { selId = id; tab = 'live'; picking = false; redrawNow($) },
        older: () => { if (pos > 0) { selId = ids[pos - 1]; redrawNow($) } },
        newer: () => { if (pos >= 0 && pos < ids.length - 1) { selId = pos + 1 === ids.length - 1 ? null : ids[pos + 1]; redrawNow($) } },
        follow: () => { selId = null; redrawNow($) },
        toggleExpand: () => { expanded = !expanded; $.ui.invalidate('ui.render') },
        answer: (text) => sendAnswer($, job.id, text),
        cancel: () => stopJob($, job.id),
        togglePicker: () => { picking = !picking; $.ui.invalidate('ui.render') },
        rerunOn: (model) => rerunOn($, job.id, model),
        toggleAutobench: () => setAutobench($, benchOn ? 'off' : 'on'),
        askModel: (n) => { askAboutModel($, n); say($, `Asked Claude where ${familyName(n.family)} fits.`) },
        dismissModel: (n) => setting($, ['ignore', n.family, 'on'], `${familyName(n.family)} hidden. Undo: agent-handoff config ignore ${n.family} off`),
        resetLadder: (wk) => setting($, ['ladder', wk, 'default'], `${wk} is back on the built-in ladder.`),
        toggleWorker: (w) => {
          const isOn = settingsOf(cfg).workers[w]
          return setting($, ['worker', w, isOn ? 'off' : 'on'], `${w} ${isOn ? 'turned off: routing won’t use it' : 'turned on'}.`)
        },
        setBackend: (b) => setting($, ['backend', b], b === 'auto' ? 'Default worker: auto (picked per task).' : `Default worker: ${b}.`),
        toggleModel: (m) => {
          const isOn = !settingsOf(cfg).disabled.has(m)
          return setting($, ['model', m, isOn ? 'off' : 'on'], `${shortModel(m)} ${isOn ? 'turned off: routing skips it' : 'turned on'}.`)
        },
        stepLimit: (which, delta) => {
          const lim = settingsOf(cfg).limits
          const max = which === 'low' ? 50 : Math.min(30, pctOf(lim.low))
          const want = Math.max(0, Math.min(max, pctOf(lim[which]) + delta))
          if (want === pctOf(lim[which])) return
          return setting($, ['limit', which, String(want)], which === 'low'
            ? `Prefer the other worker when one has under ${want}% left.`
            : want ? `Never use a worker with under ${want}% left.` : 'No hard stop: a worker is used until it hits its limit.')
        },
      },
    })
  })
}
