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
| `description` | none | One line on what is true when a run is done, not what the job does. Shown beside the id. |
| `cron` | none | When it runs by itself. A line that does not read stops the agent loading. |
| `timezone` | `"UTC"` | The timezone the cron line is read in. |
| `model` | the agent's | The model it asks. |

Paths in `prompt()` and `markdownJob()` are inside the agent's folder. A plain
string in `markdown` is the words themselves, not a path.

The job runs with the agent's purpose, tools, skills and memory, and stops
at the agent's `stopWhen`, 40 steps unless it says.

## Files kept somewhere else

Instructions can carry a file from outside the agent's folder, like a price
list or a FAQ: `prompt("purpose.md", { include: { prices: "/home/you/prices.md" } })`.
Each goes after the words, in a tag of its name (`<prices>`). An edit to it is
live in a second, and a missing one stops the agent loading, saying which.

## Skills and scripts

A **skill** is a markdown file in the agent's `skills/` folder, with a `name`
and a `description` at the top, saying when to do something and how. The agent
sees every skill's description and opens the one it needs. Skills are words,
live with no restart, and the first thing to reach for when the agent should
handle something better.

A skill can also be a folder, `skills/<name>/SKILL.md`, named for the folder
unless its top says otherwise, with whatever it needs beside it: longer notes,
templates, and scripts. Opening it lists those files, so the agent reads the
notes when the skill says to and knows which scripts it can run. The folder is
the whole capability, so it can be copied to another agent as it is.

```
skills/fill-pdfs/
  SKILL.md          when and how, the words
  scripts/fill.py   executable, run as fill-pdfs/scripts/fill.py
```

A **script** is an executable file in `scripts/`, or inside a skill's folder,
which the agent runs with `scriptRun` when `abilities: { scripts: true }` is
on. One in `scripts/` runs in that folder and is named by its file name; one in
a skill runs in that skill's folder and is named `<skill>/<path>`. Both get the
memory folder in `MEMORY_FOLDER`. A script nothing mentions does not belong
there: give each one a skill that says when to run it, which a skill's own
scripts have by being in it.

**A file somebody sends is saved for the scripts.** On a channel that takes
files, an agent with `scripts` on also gets each file saved in the state
folder, `received/<agent id>/`, and its full path added to the message, so a
script can be handed it. A file is kept for 30 days, and never for a guest.
On a channel that can send files (Telegram), the agent gets `chatSendFile` in
that conversation, to send back a file from its memory or one it was sent.

Instructions and skills say what to do, not which of the runtime's tools does
it: "note it in your memory", "run `deploy.sh`", never `memoryEditFile` or
`scriptRun`. Each tool comes with its own name and description, so the model
finds it, and a rename in the runtime then breaks nothing. A tool the agent
defines itself is yours, so name it as you like.

## What an agent may change about itself

Every agent may rewrite its own purpose, skills and jobs, and its code:
`agent.ts`, its tools, services, channels and scripts. `selfImprovement: false`
turns that off, which suits an agent that already does what you want. Every change is a
commit under its name, which you can read and undo from the dashboard. It never
writes its evals or its memory. See [Abilities](/docs/abilities).

So "every morning at 7, tell me
what is most urgent in my mail" can end as a job it wrote. It writes every
file one change needs in one call, committed as one change. With code among
them, the agent is loaded once with all of them, as the next reload would load
it, and type checked when your project has TypeScript and a `tsconfig.json`;
if it would not load, would not type check, or a job would run more than once
an hour, every file is put back as it was, and the agent is told why. Reloads wait for that check, so
nothing unchecked goes live.
Code an agent writes runs as chloe does and can reach whatever chloe can, so
its folder bounds what `selfWriteFile` writes, not what that code does. A rule
it must never change belongs in code it cannot reach, not in a file in its
folder.

Any agent can read its own folder in any turn (`ownListFiles`,
`ownReadFile`): its purpose, skills, jobs and code, to say how it does
something or to read its own source. When its owner asks, it also gets its
runs (`ownListRuns`, `ownReadRun`), which hold what other people said, the
guides for the version installed (`ownReadGuide`), and it can try one of its
jobs (`ownTryJob`, a [trial](/docs/jobs#a-trial-run) that sends nothing). It changes
itself only when its owner asks: a message from the agent's owner
on one of its channels (`owner` in settings, or the first entry in the
channel's `allowFrom`), or from the account on the dashboard. A job, a
schedule, a token and a visitor never get `selfWriteFile`, and an agent step
handed it is refused. Once any tool in a reply has read something from
outside the agent (mail, a web page, a script, an MCP server, one of its own
runs, which holds what those said, or a trial of one of its jobs), a change is refused for the rest of that
reply, because what it read may be what asked for the change. The owner's
next message may ask for it, and every change is a commit that can be read and
undone. In a turn without `selfWriteFile`, an agent that may change itself
is told so by the runtime, and to keep what it learned in its memory and say
which file it would change, so its purpose need not say it.

In every turn but a visitor's, an agent that may change itself is also told
two things about growing. What it cannot do, it cannot do yet: it says so, and
what learning it would take. And its way of working is to find a way code can
do the work, so the same request gets the same answer every time: a habit, a
skill whose script does it when asked or a job in code on a schedule, asking a
model only where it needs judgement and costing a fraction of the turn. Before
doing something by hand it looks for a habit that already does it, and it
offers to make one when it does by hand work it will be asked for again.
