---
title: An agent
order: 1.5
summary: Every option defineAgent takes, what each one controls, and where an agent's files go.
---

An agent is one `agent.ts` that calls `defineAgent`, listed in
`chloe.config.ts`. That file is the whole list of what the agent is: a job,
tool or channel exists only because it names it.

```ts file=example/agent.ts
```

## Options

| Option | Default | What it controls |
|---|---|---|
| `id` | required | What its runs and memory are filed under. Do not change it once it has run. |
| `description` | required | One line, shown wherever agents are listed. |
| `instructions` | required | What it is told on every turn: `prompt("instructions.md")` for a file in its folder, or the words themselves. |
| `label` | the `id` | What the dashboard calls it, and the name its emails are sent under. Free to change. |
| `model` | `model.defaultModel` in settings | The model it asks, like `"anthropic/claude-sonnet-5"`. A job or a step can name its own. See [Models](/docs/models). |
| `tools` | none | What a model may call, keyed by the name it sees. See [Tools](/docs/tools). |
| `jobs` | none | Its jobs: each one imported, or `markdownJob("jobs/<id>.md")` for a prompt. See [A job is a workflow](/docs/jobs). |
| `channels` | none | Where people reach it. See [Channels](/docs/channels). |
| `connections` | none | MCP servers only this agent reaches. See [Connections](/docs/connections). |
| `features` | memory on, the rest off | Built-in tools to switch on. Below. |
| `memory` | its own folder in `data/memory` | Where it keeps notes between runs. Below. |
| `folder` | the folder `agent.ts` is in | Where its skills, scripts, prompts and evals are. |
| `stopWhen` | 40 steps | When a turn has to stop, as the AI SDK's `stopWhen`, like `isStepCount(20)`. |
| `toolApproval` | every call allowed | Asked before each tool call in a turn, as the AI SDK's `toolApproval`. A call that needs a person is refused, because a turn does not wait. |

A turn is one answer to a message, or one run of a job that is a prompt. A
job's code sets its own limits on each step: see
[Step, model, agent](/docs/primitives).

## features

Switched on in the definition, with nothing to import:
`features: { memoryPerUser: true, runScripts: true }`. Every tool each one
adds, and the ones an agent has with no feature, are on
[Features](/docs/features).

| Feature | Default | What it adds |
|---|---|---|
| `memory` | on | `memoryListFiles`, `memoryReadFile`, `memorySearchFiles`, `memoryWriteFile` and `memoryEditFile`, inside its memory folder and nowhere else. |
| `memoryPerUser` | off | `memoryWriteUserNotes`: a note per person it talks to, `users/<channel>-<id>.md` in its memory, shown at the top of that person's turns. Whose note it is comes from who sent the message, never from the model. |
| `selfImprovement` | on | `selfWriteFile`, to change its own folder: instructions, skills, jobs, and its code. `false` turns it off, `{ code: false }` keeps it to plain text, `{ files: ["md"] }` narrows it, `{ except: ["PERMISSIONS.md"] }` keeps a file read only and turns code off. Never evals or memory, and a job it changes must still load and run at most once an hour. Every write is a commit you can undo from the dashboard. It writes only when its owner asks, and not once a tool in the same conversation read from outside ([what an agent may change](/docs/prompts#what-an-agent-may-change-about-itself)). |
| `runScripts` | off | `scriptRun`, to run a file in its own `scripts/` folder. The agent is refused as it loads if that folder is empty. |

Every agent also has four tools that need no feature, in turns its owner wrote
and no others: `selfListFiles` and `selfReadFile` read its own folder (never
its memory), and `selfListRuns` and `selfReadRun` read its own runs, so you can
ask "how do you send the morning facts?" or "what did you send me yesterday?".
A job, a token and a visitor never get them, because a run holds what
other people said. Who the owner is: `owner` in settings, the first entry in a
channel's `allowFrom`, or the account on the dashboard.

## memory

Unsaid, an agent's memory is `data/memory/<id>/`, and every run that changes it
is one git commit, under the agent's id. Name a folder only when the agent
shares one with a person:

| Option | Default | What it controls |
|---|---|---|
| `folder` | `data/memory/<id>` | An absolute path. |
| `label` | `"Memory"` | What the dashboard calls it. |
| `commit` | `"each run"`, or `false` for a folder you name | `"each run"`: what a run changed is committed when it ends. `true`: every write is its own commit. `false`: never. |

The memory tools, the dashboard, a job's `work.memory` and a script's
`MEMORY_FOLDER` all read this one setting.

## Its folder

```
agent.ts          the definition
instructions.md   what instructions points at
jobs/             its jobs, code or markdown
tools/            its own tools
channels/         one file per channel
services/         plain functions its jobs and tools call
skills/<name>.md  read by looking: see A prompt with tools
scripts/          what scriptRun may run
evals/            cases that score its prompts
```

Only `skills/` is read by looking. Everything else exists because `agent.ts`
imports it, and a job file that `agent.ts` does not name fails `npm run test`.
An edit to any of it is live within a second, with no restart.

## Running it from a script

`agent.run({ job, input })` runs one of its jobs in this process and waits for
it, and `agent.ask({ prompt })` asks it one thing. Both are written to the run
history. A file with no `chloe.config.ts` above it is a project of its own:
[One file](/examples/one-file) is a whole agent run with `node`.
