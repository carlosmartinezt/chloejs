---
title: A prompt with tools
order: 5
summary: A job that is only words, the four keys it takes, skills and scripts, and what an agent may change about itself.
---

Ask a model. If it asks for tools, run them, hand back the answers, and ask
again, until it stops asking. That loop runs a chat turn, a job's agent step
(bounded by your code, see [Step, model, agent](/docs/primitives)), and a job
that is only a prompt, which is this page.

Make a whole job a prompt only when the work is open ended from end to end:
writing the evening note, working out what a week of failures means.

## A job that is a prompt

Two ways to write one. A `.ts` job with `markdown` where `run` would be, pointing
at its words, which keeps the cron line in code:

```ts file=example/jobs/how-it-went.ts
```

```md file=example/jobs/how-it-went.md
```

Or one `.md` file with its settings at the top, named in `agent.ts` with
`markdownJob("jobs/<id>.md")`. Its file name is its id, and it takes these four
keys, all optional, and no others:

| Key | Default | What it controls |
|---|---|---|
| `description` | none | One line, shown beside the id. |
| `cron` | none | When it runs by itself. A line that does not read stops the agent loading. |
| `timezone` | `"UTC"` | The timezone the cron line is read in. |
| `model` | the agent's | The model it asks. |

Paths in `prompt()` and `markdownJob()` are inside the agent's folder. A plain
string in `markdown` is the words themselves, not a path.

The job runs with the agent's instructions, tools, skills and memory, and stops
at the agent's `stopWhen`, 40 steps unless it says.

## Files kept somewhere else

Instructions can carry a file from outside the agent's folder, like a price
list or a FAQ: `prompt("instructions.md", { include: { prices: "/home/you/prices.md" } })`.
Each goes after the words, in a tag of its name (`<prices>`). An edit to it is
live in a second, and a missing one stops the agent loading, saying which.

## Skills and scripts

A **skill** is a markdown file in the agent's `skills/` folder, with a `name`
and a `description` at the top, saying when to do something and how. The agent
sees every skill's description and opens the one it needs. Skills are words,
live with no restart, and the first thing to reach for when the agent should
handle something better.

A **script** is any executable file in `scripts/`, which the agent runs with
`scriptRun` when `features: { runScripts: true }` is on. It runs in that folder,
with the memory folder in `MEMORY_FOLDER`. A script nothing mentions does not
belong there: give each one a skill that says when to run it.

## What an agent may change about itself

With `selfImprovement` on, it may rewrite its own instructions, skills and
markdown jobs. Every change is a commit under its name, which you can read and
undo from the dashboard. It never writes code (tools, scripts, channels, any
`.ts`, `.js`, `.py` or `.sh`), its evals, or a new job, because code it wrote is
code it would then run as itself. See [An agent](/docs/agents#features).
