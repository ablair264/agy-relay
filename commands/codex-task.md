---
description: Hand a task to Codex (GPT) through agy-relay
argument-hint: "[--write] [--model model:effort] <task>"
---

Use the agy-relay skill to hand this task to **Codex** (pass `--backend codex`; do not route it to agy):

$ARGUMENTS

Choose `--dir` (the narrowest folder holding every file it needs), `--write` only if the task edits files, `--tests` if there is a gate to run, and `--kind`. Keep any `--model` or `--write` the user wrote above. Run `agy-relay quota` first; if Codex is at its limit, say so and ask before switching to agy. Start the run in the background, then follow the skill: answer questions, review the result, and report back.
