# agent-handoff

**A Claude Code plugin that hands coding tasks to Codex (GPT) or Antigravity (Gemini), shows the worker live in a pane, and benchmarks every handoff automatically so the next task goes to the best model for the job.**

Claude stays in charge. It writes the brief, picks the worker and model, answers the worker's questions, runs your tests, reads the diff, and rates the result. You watch it all in the `/handoff` pane beside the chat.

## What you get

- **Slash commands.** `/agent-handoff:codex-task` and `/agent-handoff:agy-task` send a task to a named worker. You can also just ask Claude to "hand this off" and it picks the worker itself.
- **The `/handoff` pane.** It opens on its own when a handoff starts. It shows a timeline of the handoff (brief, pickup, each tool call, questions, answers, test result, rating), what the worker is doing now, and how long it has been quiet. It has three tabs: **Live**, **Jobs** and **Bench**.
- **A band above the prompt** while a worker runs, and toasts when it picks up, asks a question, finishes or stalls.
- **Several jobs at once.** A Codex job and an agy job can run side by side, and jobs started from other Claude Code sessions show up too. The band gives each one its own row, and the pane lists them all with live progress, so you don't have to switch between them.
- **Answer from the pane.** When the worker asks a question, type the answer in the pane. The worker carries on in the same conversation and Claude is told.
- **Automatic benchmarking.** When a handoff finishes, Claude reviews it and rates it pass, partial or fail without being asked. The ratings decide which model the next task of that kind gets. You can turn this off.
- **A watchdog.** It stops a worker that stalls, loops on the same call, or runs past its time limit, and tells Claude what happened.

## Requirements

- macOS or Linux, with Node.js 18+ and Git.
- Claude Code 2.1.287 or later (needed for the pane).
- At least one worker CLI, installed and signed in:
  - **Codex**: `npm install -g @openai/codex`, then `codex login`.
  - **Antigravity**: the `agy` CLI, signed in.

## Install

Run this inside Claude Code:

```text
/plugin install agent-handoff --marketplace ablair264/claude-code-agent-handoff
```

That's all. On the first handoff, Claude runs a one-time setup that puts the `agent-handoff` command on your PATH and connects the pane. If setup finds a problem, such as Codex not being signed in, Claude tells you the command to run.

To try a local checkout instead, start Claude Code with `claude --plugin-dir /path/to/agent-handoff`.

## Your first handoff

In any project, try one of these:

```text
/agent-handoff:codex-task Summarize how the tests in this repository are laid out.
/agent-handoff:agy-task Summarize how the tests in this repository are laid out.
```

Or ask in your own words, for example: *"Hand off writing unit tests for src/parser.ts to Codex, and run `npm test` when it's done."*

The `/handoff` pane opens and follows the job. Workers are **read-only by default**. Claude allows file edits only when the task needs them, and the worker never commits, pushes or changes branches. When the job ends, Claude checks the Git diff and the test result itself. It never takes the worker's word that the tests passed.

## The /handoff pane

| Command | Opens |
|---|---|
| `/handoff` | Live tab, following the latest job |
| `/handoff jobs` | Recent jobs; select one to see its timeline |
| `/handoff bench` | Pass rate, speed and token use per model and kind of task, plus the auto-benchmark switch |
| `/handoff <job id>` | One job's timeline |

When more than one job is active, the Live tab starts with an **Active** list: one row per job with its worker, state, model, what it's doing right now and how long it has been running. Jobs waiting on your answer stay listed for 30 minutes, and finished jobs for a minute. `▸` marks the job whose full timeline is shown below; select another row to switch. The band above the prompt shows the same jobs, one row each, and puts jobs with a question first when there isn't room for all of them.

Pane keys: `c` cancels the running job, `e` expands full replies, `o`/`n` step to older or newer jobs, `l` goes back to following the latest job, and `a` (on the Bench tab) switches auto-benchmarking.

## Auto-benchmarking

Auto-benchmarking is **on** by default. With it on:

1. A worker finishes a job.
2. Claude reviews it straight away: the task, the worker's summary, what Git says changed, the diff, and the test result.
3. Claude rates it **pass** (right and usable as is), **partial** (worked, but Claude had to fix or finish it) or **fail** (wrong, unusable, or it gamed the tests), with a short reason.
4. The rating is saved in a local ledger. The next task of the same kind starts on the cheapest model that keeps passing. A model that drops below 70% is replaced by a stronger one, and a cheaper one gets a try now and then.

If Claude wasn't watching when a job finished (for example, you answered the worker from the pane), the plugin asks Claude to rate it 20 seconds after it finishes. Jobs are only ever rated by the session that started them.

Each rating costs a short Claude turn. Turn auto-benchmarking off if you'd rather not spend those:

| Where | Off | On |
|---|---|---|
| In Claude Code | `/handoff autobench off` | `/handoff autobench on` |
| In the pane | Bench tab → **Turn off** (or `a`) | Bench tab → **Turn on** |
| In a terminal | `agent-handoff autobench off` | `agent-handoff autobench on` |
| For one shell | `AGENT_HANDOFF_AUTOBENCH=0` | `AGENT_HANDOFF_AUTOBENCH=1` |

With it off, finished jobs aren't rated, each kind of task uses a fixed model, and the pane stops showing "Awaiting Claude's review". Jobs are still logged, so the ledger has data when you turn it back on. Claude still reads the diff of any result it relies on, because that is about correctness, not benchmarking.

## Coming from agy-relay

This plugin used to be called **agy-relay**. To switch:

1. In Claude Code, run `/plugin uninstall agy-relay`, then install `agent-handoff` as shown above.
2. On the first run, your existing `~/.agy-relay` folder (jobs, ledger and settings) moves to `~/.agent-handoff`, including your benchmark setting.
3. The next `agent-handoff setup` removes the old `agy-relay` launcher from your PATH.

The renamed pieces:

| Before | Now |
|---|---|
| `/agy` pane | `/handoff` |
| `/agy-relay:codex-task`, `/agy-relay:agy-task` | `/agent-handoff:codex-task`, `/agent-handoff:agy-task` |
| `agy-relay` command | `agent-handoff` |
| `agy-relay config bench on\|off` | `agent-handoff autobench on\|off` |
| `AGY_RELAY_*` variables | `AGENT_HANDOFF_*` |

## Using it from a terminal

Claude drives the CLI for you, but you can use it directly too:

```sh
agent-handoff run --backend auto --dir . "Summarize the test layout in this repository."
agent-handoff run --backend codex --write --tests "npm test" --dir . "Add tests for src/parser.ts."
agent-handoff status          # what the latest job is doing
agent-handoff review          # task, summary, diff and test result in one place
agent-handoff bench           # pass rates per kind of task and model
agent-handoff quota           # usage left on each worker
agent-handoff config backend auto|agy|codex
agent-handoff doctor          # check node, workers, sign-in, PATH and the pane
```

If you didn't install through Claude Code, run `node cli/agent-handoff setup` from a checkout, then follow any PATH instructions it prints.

## Data and privacy

Everything is stored locally under `~/.agent-handoff/` (or `AGENT_HANDOFF_HOME`): job prompts, worker output, events, reviews, settings and the benchmark ledger. Nothing is uploaded by this plugin. The worker CLI you hand off to (Codex or Antigravity) sends the task and the files it reads to its own provider, under that provider's terms.

## Development

```sh
npm test                  # CLI, router, queue and setup tests (local fixtures)
npm run test:mod          # pane and band tests, with Claude Code's built-in runner
claude plugin validate .
```
