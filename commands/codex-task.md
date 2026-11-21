---
description: Hand a coding task to Codex (GPT) and follow it in the /handoff pane
argument-hint: "[--write] [--model model:effort] <task>"
---

Use the agent-handoff skill to hand this task to **Codex** (pass `--backend codex`; do not route it to agy):

$ARGUMENTS

Choose `--dir` (the narrowest folder that holds every file it needs), add `--write` only if the task edits files, add `--tests` if there is a check to run, and set `--kind`. Keep any `--model` or `--write` the user wrote above. Run `agent-handoff quota` first; if Codex is at its limit, say so and ask before switching to agy. Start the run in the background, then follow the skill: answer the worker's questions, review the result, rate it if auto-benchmarking is on, and report back.
