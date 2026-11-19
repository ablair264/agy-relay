---
name: agy-relay
description: Hand a task to a worker agent — Antigravity (agy / Gemini) or the Codex CLI (GPT) — and stay in contact with it. Picks the backend and model from a benchmark ledger and remaining quota (or fixed rungs with the bench off), watches the run live (picked up, working, stalled, looping, asking a question, blocked, done), lets you answer its questions in the same conversation, runs the test gate itself, and records every outcome so routing improves. Use when the user says hand off / delegate / send to agy, Antigravity, Gemini or Codex, or for bulk, repetitive or long-read work worth more than the round trip. Not for small or judgement-heavy edits.
---

# agy-relay

Claude orchestrates and owns correctness; the worker executes. The worker is a **backend**: `agy` (Antigravity, Gemini models) or `codex` (Codex CLI, GPT models). Below, "the worker" means whichever one the job runs on. `agy-relay` is one Node CLI (source in `cli/` and `lib/` here; `agy-relay setup` puts a launcher on PATH). Data lives in `~/.agy-relay/` (`jobs/<id>/`, `ledger.jsonl`, `config.json`).

## First use on a machine

If `agy-relay` is not found (`command not found`, exit 127), run setup from this skill's base directory, then carry on:

```sh
node "<this skill's base directory>/cli/agy-relay" setup
```

It installs an `agy-relay` launcher on PATH (it keeps working across plugin updates), readies `~/.agy-relay` and the pane, and prints a doctor checklist. Act on any `✗`/`!` line it prints: tell the user exactly what to run (`codex login`, signing in to agy, adding a folder to PATH); never install a backend yourself. `agy-relay doctor` reruns the checks any time.

## When to hand off

Hand off: bulk scaffolding, test suites against a spec, mechanical migrations, long reads that come back as a short digest, web lookups.
Do it yourself: anything you can finish faster than writing the brief, judgement-heavy design, security-sensitive changes.

## Run a task

```sh
agy-relay route [opts] "task"          # dry run: which backend and model, and why
agy-relay run --dir <repo> [--backend auto|agy|codex] [--write] [--tests "<gate cmd>"] [--kind K] "task"
```

- `--backend` picks the worker. When the user names one (or uses `/agy-task` / `/codex-task`), pass it. When the choice is yours, run `agy-relay quota` first (free: no model turn) and weigh the usage left on each: avoid a backend under 20% of its tighter window (5-hour or weekly) when the other has more, never pick one that is limited, and say in one line which you chose and why. `auto` (the default) applies the same rule: it skips a limited backend, prefers the one with usage left over one under 20%, then the better pass rate for that kind (bench on, 3+ runs each), then the most usage left.
- Read-only is the default (agy plan mode + sandbox; codex `read-only` sandbox). Add `--write` for edits (agy accept-edits; codex `workspace-write`, approvals never).
- `--dir` is the workspace the worker reads and writes. Use the narrowest folder that holds every file it needs.
- Write the task data-first: name the files, the questions, the output wanted. Point at files rather than pasting big context; a 17 KB pasted prompt has hung agy before.
- `--tests` is run by the relay after the worker reports done. The worker's own "tests pass" is never trusted.
- One run at a time per backend (concurrent agy runs hang each other). A `run` or `answer` while that backend is busy queues (first come, first served), prints `queued: … position N`, shows as `queued` in the pane and starts on its own; `cancel <id>` drops it. `--no-wait` exits 3 instead; `--wait-max 4h` caps the wait. An agy job and a codex job run side by side.

`run` stays in the foreground and prints a heartbeat line per tool call. For anything longer than a minute or two, start it with the Bash tool's `run_in_background: true`; you are notified when it exits. While waiting:

```sh
agy-relay status [id]    # state, current tool, idle seconds, errors, question
agy-relay tail [id]      # the heartbeat log
agy-relay cancel [id]
```

## Talking to the worker

The worker ends every turn with a JSON status (agy `--json-schema`, codex `--output-schema`): `done`, `question`, `blocked` or `failed`. The brief tells it to stop and ask rather than guess.

| Exit | State | What you do |
|---|---|---|
| 0 | done | `agy-relay review <id>`, judge it, then (bench on) `agy-relay verify <id> pass\|partial\|fail --note "why"` |
| 10 | question | Answer it if the code or the user's instructions settle it; otherwise ask the user. Then `agy-relay answer <id> "<answer>"` |
| 11 | blocked | Fix the blocker or explain, then `answer` |
| 12 | stalled / looping / timeout / stalled_startup | `answer <id> "Report your status and finish."` once; if it stalls again, do the work yourself |
| 13 | failed | Read `tail`, decide whether to retry on a stronger model (`--model`) or do it yourself |
| 14 | tests_failed | The gate tail is printed. `answer` with the failure, or fix it yourself |
| 16 | limited | The backend hit its usage limit (reset time saved; `auto` skips it until then). Rerun with the other `--backend`, or do it yourself |

`answer` resumes the same conversation (agy `--conversation`, codex `exec resume <thread>`), so the worker keeps its context. Stall rules: no first event in 90 s (agy's "Fetching available models" hang), no event for `--stall` seconds (agy 240, codex 480 since it reasons silently; doubled inside a shell command), the same tool call five times in a row, or the turn limit (`--timeout`, default 30m).

## The Claude Code pane

The Claude Code plugin also includes a mod (code in `hooks/`). It reads `~/.agy-relay` and shows:

- **A pane, `/agy`** (opens by itself when you run `agy-relay run`): a Claude ⇄ agy handoff timeline (brief, pickup, each tool call, question, answer, gate, verdict), what agy is doing now, an idle bar against the stall limit, and an activity strip in the Desktop app. Tabs: Live, Jobs, Bench. A Cancel button, and an answer field when agy asks. Until you rate a finished job, it shows "Waiting for Claude's review".
- **A band above the prompt** while a job runs or waits on a question, and toasts when agy picks up, asks, finishes or stalls.

If the user answers agy from the pane, you get a message from the mod saying so. The relay has already resumed the job, so don't `answer` it again. Follow it with `agy-relay status <id>` and review the result when it finishes. If a finished job still has no verdict after 45 s, the mod sends you one message asking you to review it (not when the bench is off).

## Benchmark on or off

```sh
agy-relay config                 # show backend and bench
agy-relay config bench off|on    # AGY_RELAY_BENCH=0 overrides for one shell
agy-relay config backend auto|agy|codex
```

The bench itself spends no model tokens: it is a local ledger of runs you already made. What costs Claude tokens is rating every job and the mod's review nudge. With the bench **off**: routing uses fixed starting rungs (no ledger, no exploring), the mod never asks for a verdict, and you skip `verify`. Runs are still logged, so turning it back on has data. Still `review` any result you rely on: that is correctness, not benchmarking.

## Rate every finished job (bench on) — you own the benchmark

With the bench on, rate every job that ends `done` or `tests_failed`, including ones you didn't start. `agy-relay review <id>` prints the task, agy's summary, what git says changed, the diff, the gate and the warnings. Judge the work against the task, then record:

- `pass`: correct and usable as it is
- `partial`: it worked but you had to fix or finish it (counts as half)
- `fail`: wrong, unusable, out of scope, or it gamed the gate

Always add `--note` with the reason in a few words (what was wrong, what you fixed). Fix any problem yourself after rating: the rating is about agy's output, not the end result.

## Verify — non-negotiable

The final report lists what git says changed, not what agy claims, and warns when agy committed, touched dependency folders (`node_modules`, `site-packages`, `.venv`: it has patched installed packages to force a pass before), claimed files git doesn't show, or a read-only run changed files. Read the diff, rerun the gate yourself if anything looks off, then record the verdict. In a git worktree, ignored files (e.g. local databases) are missing, so tests guarded by "skip if file exists" pass vacuously: copy the input in before trusting the gate.

## Model routing

```sh
agy-relay bench [--kind K]   # pass rate, median seconds and tokens per kind x model
agy-relay quota              # Gemini pool 5-hour / weekly (Neon + Hydrogen) and Argon weekly; any Codex usage-limit reset
agy-relay models             # each backend's ladder checked against what it offers
```

Each backend has a six-rung ladder, cheapest first. agy (Gemini 4; 3.8 Flash is retired): Hydrogen low → Neon low → Hydrogen high → Neon medium → Neon high → Neon xhigh. Each rung is the cheapest model at its level on Artificial Analysis figures; Hydrogen medium/xhigh and every Argon effort are left out because a cheaper Neon scores higher. Hydrogen low is weak at agentic work (Terminal-Bench 7%), so keep it to lookups and digests. Claude and GPT models in agy are never used. codex (`model:effort`): luna low → luna medium → sol 6.1 low → medium → high → astra medium. Each kind starts at a rung: search rung 1; analysis, scaffold, tests rung 2; implement rung 3; review rung 5; `--complex` adds two rungs. With the bench on, the ledger then moves it. The ledger then moves it: below 70% pass over 3+ weighted runs escalates; the rung below at 85%+ steps down; with too little data on the rung below, 20% of runs try it (`--no-explore` or `AGY_RELAY_EXPLORE=0` to stop). Neon and Hydrogen share one Gemini pool; Argon has its own weekly pool. When the Gemini pool's tighter window is under 10% and Argon's weekly is 15%+, the pick overflows to Argon (medium for the lower three rungs, high for the upper three); agy counts as limited only when both are spent. Scoring: your verdict (pass 1, partial 0.5, fail 0) or the test gate counts as a full run; agy's unrated "done" counts at half weight. Your ratings are what make routing learn.

## Known environment issues

- The report counts worker shell calls denied by a pre-tool hook as hook denials. Use the worker's hook configuration to diagnose recurring denials.
- Model ids come from the first column of `agy models` and from `codex debug models`; `agy-relay models` checks the ladders against them (cached 24 h in `~/.agy-relay/`).
- Codex: the relay uses the `codex` on PATH (a stale `/usr/local/bin/codex` 0.137 also exists on this Mac) and saves that path in the job so a resume from the pane uses the same one. Codex has no free usage check; the relay learns the reset time from the "usage limit" error.
