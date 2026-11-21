# agent-handoff

**A Claude Code plugin that hands coding tasks to Codex (GPT) or Antigravity (Gemini), shows the worker live in a pane, and benchmarks every handoff automatically so the next task goes to the best model for the job.**

Claude stays in charge. It writes the brief, picks the worker and model, answers the worker's questions, runs your tests, reads the diff, and rates the result. You watch it all in the `/handoff` pane beside the chat.

## What you get

- **Slash commands.** `/agent-handoff:codex-task` and `/agent-handoff:agy-task` send a task to a named worker. You can also just ask Claude to "hand this off" and it picks the worker itself.
- **The `/handoff` pane.** It opens on its own when a handoff starts. It shows a timeline of the handoff (brief, pickup, each tool call, questions, answers, test result, rating), what the worker is doing now, and how long it has been quiet. It has three tabs: **Live**, **Jobs** and **Bench**.
- **A band above the prompt** while a worker runs, and toasts when it picks up, asks a question, finishes or stalls.
- **Several jobs at once.** A Codex job and an agy job can run side by side, and jobs started from other Claude Code sessions show up too. The band gives each one its own row, and the pane lists them all with live progress, so you don't have to switch between them.
- **See what Codex is thinking.** Codex's reasoning summaries appear in the pane as it works: the latest on a THINK line, and all of them in the timeline when you expand it.
- **Stop or change model from the pane.** Stop a job that's going the wrong way, or rerun it on a different model with one click. Claude is told either way, so it doesn't restart or wait on it.
- **Settings in the pane.** Choose which workers and models routing may use, the default worker, and your own usage cut-offs.
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

In a terminal, on each machine you want it on:

```sh
claude plugin marketplace add ablair264/agy-relay
claude plugin install agent-handoff@agent-handoff
```

Then restart Claude Code. (Inside Claude Code, `/plugin marketplace add ablair264/agy-relay` followed by `/plugin install agent-handoff@agent-handoff` does the same.)

On the first handoff, Claude runs a one-time setup that puts the `agent-handoff` command on your PATH and connects the pane. If setup finds a problem, such as Codex not being signed in, Claude tells you the command to run. You can also run it yourself afterwards with `agent-handoff doctor`.

To get updates later:

```sh
claude plugin marketplace update agent-handoff
```

then restart Claude Code. To try a local checkout instead, start Claude Code with `claude --plugin-dir /path/to/agent-handoff`.

Each machine keeps its own jobs, settings and benchmark ledger in `~/.agent-handoff`. To carry your benchmark history and settings to a new machine, copy `ledger.jsonl` and `config.json` from `~/.agent-handoff` on the old one into the same folder on the new one.

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
| `/handoff settings` | Workers, models, default worker, usage cut-offs and auto-benchmarking |
| `/handoff <job id>` | One job's timeline |

When more than one job is active, the Live tab starts with an **Active** list: one row per job with its worker, state, model, what it's doing right now and how long it has been running. Jobs waiting on your answer stay listed for 30 minutes, and finished jobs for a minute. `▸` marks the job whose full timeline is shown below; select another row to switch. The band above the prompt shows the same jobs, one row each, and puts jobs with a question first when there isn't room for all of them.

While a Codex job runs, a **THINK** line under NOW shows its latest reasoning summary (for example "⋯ Planning the CSV export"), and the band shows it when no tool is running. In the timeline, each group of tool calls shows the latest thought; press `e` to expand and read every thought in full, in order between the tool calls. These are the short summaries Codex writes about its reasoning, not its full reasoning. agy doesn't send them yet.

Under each job's timeline:

- **Stop** (`c`) ends a running job, or drops a queued one.
- **Change model** (`m`) lists every model you have turned on. Pick one and the same task runs again on it as a new job (a running job is stopped first). The pane follows the rerun, and Claude reviews it.

Other keys: `e` expands full replies, `o`/`n` step to older or newer jobs, `l` goes back to following the latest job, `a` switches auto-benchmarking, and `1`–`4` switch tabs.

### Settings

The **Settings** tab (`/handoff settings` or `4`) changes how work is routed. Every change applies to the next handoff.

| Setting | What it does |
|---|---|
| **Workers** | Turn agy or Codex off entirely, for example if you only have one of them. A worker that's off is never used, even when named. |
| **Default worker** | **auto** picks per task from usage left and pass rates; **agy** or **codex** sends every handoff there unless Claude or a slash command names the other. |
| **Models** | Turn individual models off. Routing skips them and moves to the next model on that worker's ladder (cheapest first). A model you pin yourself with `--model` is still used. |
| **Usage cut-offs** | *Prefer the other worker below* (default 20%): when a worker has less usage left than this and the other has more, the other one gets the task. *Never use a worker below* (default off): a worker under this is not used at all, and Claude tells you why. |
| **Auto-benchmark** | The same switch as on the Bench tab. |

**Prices and scores (optional).** With a free [BenchLM](https://benchlm.ai/data/access) key, the Settings tab shows each model's price per million tokens and its BenchLM coding and agentic scores in a small table, NEW models show their figures, and Ask Claude passes them along:

```sh
agent-handoff config benchlm-key <your key>   # saved in ~/.agent-handoff/benchlm-key, readable only by you
agent-handoff stats                           # the table in a terminal; --refresh fetches now
```

Run the first command yourself in a terminal rather than asking Claude, so the key doesn't end up in a chat. The data is fetched with your key, cached on your machine and refreshed weekly in the background. Each refresh uses 3 of the free plan's 1,000 monthly reads. BenchLM scores whole models, so every effort level of a model shows the same scores.

BenchLM's data is licensed [CC BY-NC 4.0](https://benchlm.ai/terms#data-access): free for non-commercial use with credit, which the pane and `stats` show ("Data from BenchLM.ai"). This plugin doesn't include or redistribute any BenchLM data. If you use it commercially, check BenchLM's terms for your use.

**New models.** When Codex or agy starts offering a model family that isn't on its ladder (for example a new Sol release), you get a toast once, the Settings tab shows a dot, and the model appears under that worker with a **NEW** tag and two buttons:

- **Ask Claude**: Claude compares it with the current ladder on price and coding benchmarks and suggests where it fits. Nothing changes until you agree. Claude then saves your own ladder with `agent-handoff config ladder <worker> <id> <id> …`, which overrides the built-in one (Settings shows "your ladder" and a button to go back to the built-in one).
- **Dismiss**: hide it (`agent-handoff config ignore <family> off` brings it back).

The plugin learns what each worker offers from `codex debug models` and `agy models`, which it caches and refreshes daily. Run `agent-handoff models` to refresh now and list anything new.

Usage left means the tighter of the 5-hour and weekly windows, as shown in the meters at the top of the pane. The same settings are available from a terminal:

```sh
agent-handoff config worker agy off
agent-handoff config model gpt-6-luna:low off
agent-handoff config limit low 25      # prefer the other worker under 25% left
agent-handoff config limit stop 5      # never use a worker under 5% left
agent-handoff config                   # show everything
```

## Auto-benchmarking

Auto-benchmarking is **on** by default. With it on:

1. A worker finishes a job.
2. Claude reviews it straight away: the task, the worker's summary, what Git says changed, the diff, and the test result.
3. Claude rates it **pass** (right and usable as is), **partial** (worked, but Claude had to fix or finish it) or **fail** (wrong, unusable, or it gamed the tests), with a short reason.
4. The rating is saved in a local ledger. The next task of the same kind starts on the cheapest model that keeps passing. A model that drops below 70% is replaced by a stronger one, and a cheaper one gets a try now and then.

If a job finishes while Claude isn't handling it (for example, you answered the worker from the pane and Claude was idle), the plugin asks Claude to rate it. It asks only when there's still no rating, Claude hasn't looked at the job (`review`, `status` and so on), and the session has had no tool activity for 20 seconds, so it never interrupts Claude mid-review. Jobs are only ever rated by the session that started them.

Each rating costs a short Claude turn. Turn auto-benchmarking off if you'd rather not spend those:

| Where | Off | On |
|---|---|---|
| In Claude Code | `/handoff autobench off` | `/handoff autobench on` |
| In the pane | Bench tab → **Turn off** (or `a`) | Bench tab → **Turn on** |
| In a terminal | `agent-handoff autobench off` | `agent-handoff autobench on` |
| For one shell | `AGENT_HANDOFF_AUTOBENCH=0` | `AGENT_HANDOFF_AUTOBENCH=1` |

With it off, finished jobs aren't rated, each kind of task uses a fixed model, and the pane stops showing "Awaiting Claude's review". Jobs are still logged, so the ledger has data when you turn it back on. Claude still reads the diff of any result it relies on, because that is about correctness, not benchmarking.

## Screenshots and recordings

`agent-handoff demo` fills a separate folder (`~/.agent-handoff-demo`; your real data is never touched) with sample handoffs and keeps them moving, with no workers, no model turns and no cost:

- a Codex job implementing a CSV export, from brief to passing tests to Claude's rating, in about 35 seconds
- an agy job tracing time-zone handling, mid-run
- an agy job waiting on a question; answer it from the pane and it carries on
- six finished jobs for the Jobs tab, a ledger that fills the Bench tab, and usage meters

Stop, Change model, Answer and the Settings tab all work. The scene restarts every 150 seconds (`--cycle 300` to change that), so you can retake a recording.

```sh
agent-handoff demo                                 # keep this running
AGENT_HANDOFF_HOME=~/.agent-handoff-demo claude    # in another terminal, then type /handoff
```

For the Claude Code desktop app on macOS, run `launchctl setenv AGENT_HANDOFF_HOME ~/.agent-handoff-demo` and reopen the app. Run `launchctl unsetenv AGENT_HANDOFF_HOME` when you're done.

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
agent-handoff retry <id> --model gpt-6.2-sol:medium   # stop (if running) and rerun on another model
agent-handoff stats           # price and BenchLM scores per model (needs your BenchLM key)
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
