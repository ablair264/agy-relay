---
name: agent-handoff
description: Hand a coding task from Claude Code to a worker agent, Codex (GPT) or Antigravity (agy, Gemini), and stay in charge of it. Picks the worker and model from remaining quota and an automatic benchmark of past handoffs, watches the run live in the /handoff pane (picked up, working, stalled, looping, asking, blocked, done), answers the worker's questions in the same conversation, runs the test gate itself, then reviews and rates every finished handoff so routing improves. Use when the user says hand off, delegate, or send to Codex, agy, Antigravity or Gemini, uses /agent-handoff:codex-task or /agent-handoff:agy-task, or for bulk, repetitive or long-read work worth more than the round trip. Not for small or judgement-heavy edits.
---

# agent-handoff

You orchestrate and own correctness; the worker executes. The worker is a **backend**: `codex` (Codex CLI, GPT models) or `agy` (Antigravity, Gemini models). "The worker" below means whichever one the job runs on.

`agent-handoff` is one Node CLI (source in `cli/` and `lib/` here). The Claude Code mod in `hooks/` shows each handoff in the `/handoff` pane. Data lives in `~/.agent-handoff/` (`jobs/<id>/`, `ledger.jsonl`, `config.json`).

Every handoff follows the same loop:

1. **Brief**: start the run (`agent-handoff run …`).
2. **Watch**: answer questions and nudge stalls until it ends.
3. **Check**: `agent-handoff review <id>`: read the diff and the gate yourself.
4. **Rate**: with auto-benchmarking on, `agent-handoff verify <id> pass|partial|fail --note "why"`. Don't wait to be asked.
5. **Report**: tell the user what changed, what you fixed, and the rating.

## First use on a machine

If `agent-handoff` is not found (`command not found`, exit 127), run setup from this skill's base directory, then carry on:

```sh
node "<this skill's base directory>/cli/agent-handoff" setup
```

Setup installs an `agent-handoff` launcher on PATH (it survives plugin updates), readies `~/.agent-handoff` and the pane, moves data over from an old `~/.agy-relay` folder, and prints a doctor checklist. Act on every `✗` or `!` line: tell the user exactly what to run (`codex login`, signing in to agy, adding a folder to PATH). Never install a backend yourself. `agent-handoff doctor` reruns the checks.

## When to hand off

Hand off: bulk scaffolding, test suites against a spec, mechanical migrations, long reads that come back as a short digest, web lookups.

Do it yourself: anything you can finish faster than writing the brief, judgement-heavy design, security-sensitive changes.

## 1. Brief: start the run

```sh
agent-handoff route [opts] "task"     # dry run: which backend and model, and why
agent-handoff run --dir <repo> [--backend auto|codex|agy] [--write] [--tests "<gate cmd>"] [--kind K] "task"
```

- **Backend.** When the user names one (or uses `/agent-handoff:codex-task` or `/agent-handoff:agy-task`), pass it with `--backend`. When the choice is yours, run `agent-handoff quota` first (free: no model turn) and weigh the usage left. Avoid a backend under 20% of its tighter window (5-hour or weekly) when the other has more, never pick one that is limited, and say in one line which you chose and why. `auto` (the default) applies the same rule: it skips a limited backend, prefers one with usage left over one under 20%, then the better pass rate for that kind (auto-benchmarking on, 3+ runs each), then the most usage left.
- **Read-only is the default** (agy plan mode and sandbox; codex `read-only` sandbox). Add `--write` only for edits (agy accept-edits; codex `workspace-write`, approvals never).
- **`--dir`** is the workspace the worker reads and writes. Use the narrowest folder that holds every file it needs.
- **Write the task data-first**: name the files, the questions and the output wanted. Point at files rather than pasting big context; a 17 KB pasted prompt has hung agy before.
- **`--tests`** is run by the relay after the worker reports done. The worker's own "tests pass" is never trusted.
- **One run at a time per backend** (concurrent agy runs hang each other). A `run` or `answer` while that backend is busy waits in a queue (first come, first served), prints `queued: … position N`, shows as `queued` in the pane, and starts on its own; `cancel <id>` drops it. `--no-wait` exits 3 instead; `--wait-max 4h` caps the wait. A codex job and an agy job run side by side.

`run` stays in the foreground and prints a heartbeat line per tool call. For anything longer than a minute or two, start it with the Bash tool's `run_in_background: true`; you are notified when it exits.

## 2. Watch: talk to the worker

```sh
agent-handoff status [id]    # state, current tool, idle seconds, errors, question
agent-handoff tail [id]      # the heartbeat log
agent-handoff cancel [id]
```

The worker ends every turn with a JSON status (agy `--json-schema`, codex `--output-schema`): `done`, `question`, `blocked` or `failed`. The brief tells it to stop and ask rather than guess. Every run ends with a `next:` line; follow it.

| Exit | State | What you do |
|---|---|---|
| 0 | done | Check and rate (steps 3 and 4) |
| 10 | question | Answer it if the code or the user's instructions settle it; otherwise ask the user. Then `agent-handoff answer <id> "<answer>"` |
| 11 | blocked | Fix the blocker or explain, then `answer` |
| 12 | stalled / looping / timeout / stalled_startup | `answer <id> "Report your status and finish."` once; if it stalls again, do the work yourself |
| 13 | failed | Read `tail`, then retry on a stronger model (`--model`) or do it yourself |
| 14 | tests_failed | The gate tail is printed. `answer` with the failure, or fix it yourself; rate it either way |
| 16 | limited | The backend hit its usage limit (reset time saved; `auto` skips it until then). Rerun with the other `--backend`, or do it yourself |

`answer` resumes the same conversation (agy `--conversation`, codex `exec resume <thread>`), so the worker keeps its context.

Stall rules: no first event in 90 s (agy's "Fetching available models" hang), no event for `--stall` seconds (agy 240, codex 480 since it reasons silently; doubled inside a shell command), the same tool call five times in a row, or the turn limit (`--timeout`, default 30m).

## 3. Check: verify the result yourself

`agent-handoff review <id>` prints the task, the worker's summary, what Git says changed, the diff, the gate and any warnings. It lists what Git says changed, not what the worker claims, and warns when the worker committed, touched dependency folders (`node_modules`, `site-packages`, `.venv`: workers have patched installed packages to force a pass before), claimed files Git doesn't show, or changed files in a read-only run.

Read the diff, and rerun the gate yourself if anything looks off. In a Git worktree, ignored files (local databases, for example) are missing, so tests guarded by "skip if the file is missing" pass without testing anything: copy the input in before trusting the gate.

## 4. Rate: auto-benchmarking

Auto-benchmarking is on unless the user turned it off. The `next:` line of a finished run tells you which: with it on, it asks for `verify`; with it off, it says no verdict is needed. `agent-handoff config` also shows it.

With it **on**, rate every job that ends `done` or `tests_failed` as soon as you have reviewed it, without waiting to be asked, including jobs you didn't start but are asked about:

```sh
agent-handoff verify <id> pass|partial|fail --note "<why, in a few words>"
```

- `pass`: correct and usable as it is.
- `partial`: it worked, but you had to fix or finish it (counts as half).
- `fail`: wrong, unusable, out of scope, or it gamed the gate.

Always add `--note` (what was wrong, what you fixed). Rate the worker's output, not the end result: fix any problem yourself after rating.

If a finished job still has no rating 20 seconds after it ends (for example, the user answered the worker from the pane, so no turn of yours was watching), the mod sends you one "Auto-benchmark:" message asking for it. Only the session that started the job gets it. If you have already rated the job, ignore it.

With it **off**, skip `verify`: routing uses fixed starting rungs, nothing explores, and the mod never asks. Still review any result you rely on; that is correctness, not benchmarking. Runs are still logged, so the ledger has data if it is turned back on.

Switching it (only when the user asks):

```sh
agent-handoff autobench on|off      # or: agent-handoff config autobench on|off
```

The user can also run `/handoff autobench on|off` or use the switch on the pane's Bench tab. `AGENT_HANDOFF_AUTOBENCH=0|1` overrides it for one shell.

## The /handoff pane

The mod reads `~/.agent-handoff` and shows:

- **The `/handoff` pane**, which opens by itself when you run `agent-handoff run`. It has a handoff timeline (brief, pickup, each tool call, question, answer, gate, rating), what the worker is doing now, an idle bar against the stall limit, and an activity strip in the Desktop app. Tabs: Live, Jobs, Bench (with the auto-benchmark switch). It has a Cancel button, and an answer field when the worker asks. A finished, unrated job shows "Awaiting Claude's review" while auto-benchmarking is on.
- **A band above the prompt** while a job runs or waits on a question, and toasts when the worker picks up, asks, finishes or stalls.
- **Every active job at once.** When a codex job and an agy job run side by side (or another session has a job going), the band gives each its own row and the Live tab opens with an Active list showing each job's state and current step. Toasts and the auto-benchmark request cover every job, not just the newest.

If the user answers the worker from the pane, the mod sends you a message saying so. The relay has already resumed the job, so don't `answer` it again. Follow it with `agent-handoff status <id>`, then check and rate the result when it finishes.

## Model routing

```sh
agent-handoff bench [--kind K]   # pass rate, median seconds and tokens per kind x model
agent-handoff quota              # Gemini pool 5-hour / weekly (Neon + Hydrogen), Argon weekly, any Codex usage-limit reset
agent-handoff models             # each backend's ladder checked against what it offers
```

Each backend has a six-rung ladder, cheapest first.

- **agy** (Gemini 4; 3.8 Flash is retired): Hydrogen low → Neon low → Hydrogen high → Neon medium → Neon high → Neon xhigh. Each rung is the cheapest model at its level on Artificial Analysis figures; Hydrogen medium/xhigh and every Argon effort are left out because a cheaper Neon scores higher. Hydrogen low is weak at agentic work (Terminal-Bench 7%), so keep it to lookups and digests. Claude and GPT models in agy are never used.
- **codex** (`model:effort`): luna low → luna medium → sol 6.1 low → medium → high → astra medium.

Each kind starts at a rung: search rung 1; analysis, scaffold and tests rung 2; implement rung 3; review rung 5. `--complex` adds two rungs.

With auto-benchmarking on, the ledger then moves the pick: below 70% pass over 3+ weighted runs escalates; the rung below at 85%+ steps down; with too little data on the rung below, 20% of runs try it (`--no-explore` or `AGENT_HANDOFF_EXPLORE=0` stops that).

Neon and Hydrogen share one Gemini pool; Argon has its own weekly pool. When the Gemini pool's tighter window is under 10% and Argon's weekly is 15%+, the pick overflows to Argon (medium for the lower three rungs, high for the upper three); agy counts as limited only when both are spent.

Scoring: your rating (pass 1, partial 0.5, fail 0) or the test gate counts as a full run; the worker's unrated "done" counts at half weight. Your ratings are what make routing learn.

## Known environment issues

- The report counts worker shell calls denied by a pre-tool hook as hook denials. Use the worker's hook configuration to diagnose recurring denials.
- Model ids come from the first column of `agy models` and from `codex debug models`; `agent-handoff models` checks the ladders against them (cached 24 h in `~/.agent-handoff/`).
- Codex: the relay uses the `codex` on PATH and saves that path in the job, so a resume from the pane uses the same binary even if an older copy sits elsewhere. Codex has no free usage check; the relay learns the reset time from the "usage limit" error.
