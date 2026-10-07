---
title: A prompt with tools
order: 5
summary: The loop, what a tool is, and what an agent may change about itself.
---

Ask a model. If it asked for tools, run them, put the answers back, ask again.
Stop when it stops asking. That is the whole loop.

It runs in two places, and the difference is how much you hand over.
`work.agent()` runs it inside a job you control, bounded by the tools that step
was given, the calls you allow and the limits you set: see
[step, model, agent](/docs/primitives). A
markdown job runs it for the whole run, which is this page.

Hand over a whole run only when the work is open ended from end to end:
answering somebody on a channel, writing the evening note, working out what a
week of failures means.

## A job that is a prompt

The words are markdown, either as a `.md` file with frontmatter that `agent.ts`
names with `markdownJob("jobs/<id>.md")`, or as a `.ts` job with `markdown:` when
the job needs a line of code around its words. A `.md` beside a `.ts` of the same
name is that job's words, not a job of its own. A job has `run` or `markdown` and
never both, and the loader refuses anything with neither. Nothing in `jobs/` runs
because it is there: only `agent.ts` puts a job on the clock.

A markdown job takes four keys and no others: `cron`, `description`, `timezone`,
`model`. A `cron` that does not read stops the agent loading.

```md file=example/jobs/how-it-went.md
```

## Words kept somewhere else

Instructions can carry a file that lives outside the agent's folder, like a
CV, a price list or a FAQ: `prompt("instructions.md", { include: { cv: "/home/you/cv.md" } })`.
Each file goes after the words, in a tag of its name (`<cv>`), is watched so an
edit is live in a second, and stops the agent loading, saying which, when it is
missing.

## What a tool is

**A tool is for a model and nothing else.** The work is a plain function
published from `@chloejs/core`, and a job calls it from a step. A tool is a
description, a schema and one call over that function. Nothing in a tool does
work of its own.

A job that imports a tool is either paying a model to read a path it already
knew, or it wanted a plain function, and the tests say so. The other direction is
fine: a tool may call a job's exported function.

Three sets of tools come with the runtime, and `features` in the definition
switches each on, with nothing to import, like
`features: { selfImprovement: true, runScripts: true }`:

- `memory`, on unless it says `false`: `memoryListFiles`, `memoryReadFile`,
  `memorySearchFiles` and `memoryWriteFile`, for what it keeps from one run to the next.
  `memory` in the definition says which folder and when a change is a commit,
  and is only needed when it is not the agent's own folder inside `data/memory`.
- `selfImprovement`, off unless it says `true`: `selfListFiles`, `selfReadFile`
  and `selfWriteFile`, to change the plain text in its own folder, which is its
  instructions, its skills and the words of its jobs. `{ files: ["md"] }` narrows
  that and `{ except: ["PERMISSIONS.md"] }` keeps a path back. Never code (its
  tools, services, channels and scripts, or anything ending in .ts, .js, .py or
  .sh), never its evals, never its memory, and never a new job, because only
  `agent.ts` can name one. A job it changes must still load and may run at most
  once an hour. Every write is a commit under the agent's name, which the page
  can undo.
- `memoryPerUser`, off unless it says `true`: `memoryWriteUserNotes`, a note
  per person it talks to, in its memory under `users/`, as each channel names
  them (`users/telegram-42.md`). The runtime picks whose from who sent the
  message, and shows that note at the top of their turns.
- `runScripts`, off unless it says `true`: `scriptRun`, to run a file in its
  own `scripts/` folder. An agent with no scripts is refused as it loads.

A tool that fails does not kill the turn. A missing tool, bad arguments, or a
tool that throws all go back to the model as text it can act on, because a turn
that dies on one bad call throws away everything it had already done. So a run
that worked may still hold failures: read the trace, not just the reply.

## A tool that reaches private material is bound, not asked

The search behind a mail tool, the calendars and Drive folder behind the Google
tools, and the folder behind the memory tools, come from the agent's own
`agent.ts`. The model chooses only how far back and how many. Reading one item
re-runs that same search and refuses anything that is not in it. The Google
tools, and a service's own tools through MCP, are in
[connections](/docs/connections).

A query a model can write is a filter, not a boundary: it widens the moment a
turn goes wrong, and by then it has already read the thing. Give any new tool
that reaches private material this shape.

## Skills and scripts

A **skill** is a markdown file in `skills/` with a `name` and a `description`,
saying when to do something and which script does it. The agent sees every
skill's description and opens the ones it needs. Skills are the first thing to
reach for: they are words, and they are live with no restart.

A **script** is any executable file in `scripts/`. Shell when you are stringing
commands together, TypeScript or Python when you are parsing. The more a script
decides for itself, the less there is for a prompt to get wrong.

Every script in that folder is reachable by that agent, so if no skill or
instruction mentions one, it does not belong there.

## What an agent may change about itself

It writes its own **skills** and its own **notes**. A skill is markdown, it is
committed as it is written, and it can only point at a script that is already
there, so self-improvement always leaves a diff you can read.

It does not write its own **tools** or **scripts**. Those are code, and code an
agent writes is code it then runs as itself.
