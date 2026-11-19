# agy-relay

Hand coding tasks from Claude Code to Antigravity (`agy`) or the Codex CLI. Watch progress in the `/agy` pane, answer follow-up questions in the same worker conversation, and review the result against the Git diff and a test command you choose. The relay uses local run history and available quota to route tasks, and a watchdog flags stalled or looping workers.

## Requirements

- macOS or Linux with Node.js 18+ and Git.
- Claude Code 2.1.287+ for the live pane in the terminal.
- At least one signed-in worker: the Antigravity CLI (`agy`) or the Codex CLI (`codex`). For Codex, run `codex login` after installing it.

## Install in Claude Code

Run this command inside Claude Code.

```text
/plugin install agy-relay --marketplace ablair264/agy-relay
```

If you have a local checkout of agy-relay, run this in your terminal from the project you want to work on.

```sh
claude --plugin-dir /path/to/agy-relay
```

On the first handoff, the skill runs setup if the `agy-relay` launcher is missing. Setup installs the launcher and connects the pane.

For CLI-only use, run this in your terminal from the agy-relay checkout.

```sh
node cli/agy-relay setup
```

Follow the printed PATH instructions if needed, then run `agy-relay doctor` to check your setup.

## Try a handoff

From a project in Claude Code, use the command for your signed-in worker.

```text
/agy-relay:agy-task Summarize the test layout in this repository.
/agy-relay:codex-task Summarize the test layout in this repository.
```

Use `/agy` to reopen the pane. You can also call the relay from a terminal.

```sh
agy-relay run --backend auto --dir . "Summarize the test layout in this repository."
agy-relay status
agy-relay review
```

The relay starts jobs in read-only mode by default. Pass `--write` to allow workspace edits and `--tests "COMMAND"` to run a local verification command after the worker finishes. Read the diff and test result before accepting a job.

## Settings and data

```sh
agy-relay config backend auto
agy-relay config backend agy
agy-relay config backend codex
agy-relay config bench off
agy-relay config bench on
```

Job prompts, worker output, events, reviews, configuration, and the benchmark ledger are stored under `~/.agy-relay/` (override with `AGY_RELAY_HOME`). The worker CLI sends the delegated task and its working context to its configured provider. The benchmark uses existing run data and can ask Claude to rate completed jobs.

## Development

```sh
npm test
npm run test:mod
claude plugin validate .
```

The tests use local fixtures. The mod tests run with Claude Code's built-in test runner.
