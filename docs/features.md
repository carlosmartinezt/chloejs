---
title: Features
order: 1.6
summary: The tools chloe brings to an agent: which feature adds each one, what it does, what is on by default, and the tools every agent has with no feature.
---

# Features

A feature is a set of tools chloe has built in. You switch it on or off in
`features` in the agent's `agent.ts`, with nothing to import:
`features: { memoryPerUser: true, runScripts: true }`.

The tool names here are the ones the model sees. Your instructions and skills
should say what to do ("note it in your memory"), not name these tools, so a
rename breaks nothing ([A prompt with tools](/docs/prompts#skills-and-scripts)).

## The features

| Feature | Default | Tools it adds |
|---|---|---|
| `memory` | on | `memoryListFiles`, `memoryReadFile`, `memorySearchFiles`, `memoryWriteFile`, `memoryEditFile` |
| `selfImprovement` | on | `selfWriteFile` |
| `memoryPerUser` | off | `memoryWriteUserNotes` |
| `runScripts` | off | `scriptRun` |

### memory

The agent's notes between runs, in its memory folder and nowhere else
([An agent](/docs/agents#memory) says where that is). `false` leaves them out.

| Tool | What it does |
|---|---|
| `memoryListFiles` | Lists the files in its memory. |
| `memoryReadFile` | Reads one. |
| `memorySearchFiles` | Finds the files that contain some text. The search is plain text, not by meaning. |
| `memoryWriteFile` | Writes a whole file. |
| `memoryEditFile` | Changes part of a file. |

Every run that changes the memory is one git commit under the agent's id.

### selfImprovement

`selfWriteFile` changes files in the agent's own folder: its instructions,
skills and jobs, and its code (`agent.ts`, tools, services, channels,
scripts). It writes every file one change needs in one call, and that is one
commit you can read and undo from the dashboard. With code among them, the
agent is loaded with the new files first, and if it would not load, every file
is put back and the agent is told why.

`false` turns it off, `{ code: false }` keeps it to plain text,
`{ files: ["md"] }` narrows it to some file endings, and
`{ except: ["PERMISSIONS.md"] }` keeps a file read only and turns code off. It
never writes its evals or its memory.

It is in a turn only when the agent's owner asked, and is refused once another
tool in that conversation read from outside the agent. The whole rule is
[What an agent may change about itself](/docs/prompts#what-an-agent-may-change-about-itself).

### memoryPerUser

`memoryWriteUserNotes` keeps one note on each person the agent talks to, on any
channel, as `users/<channel>-<id>.md` in its memory. The note is shown at the
top of each turn with that person, and the tool replaces it. Whose note it is
comes from who sent the message, never from the model, so one person on two
channels has two notes. A visitor on a [web channel](/docs/channels) gets this
tool even though the channel does not name it.

### runScripts

`scriptRun` runs any file in the agent's `scripts/` folder and returns what it
printed, or lists them. Each script must be executable (`chmod +x` and a `#!`
first line), runs inside `scripts/`, and gets the memory folder in
`MEMORY_FOLDER`. With this on and `scripts/` empty, the agent does not load.
Give each script a skill that says when to run it.

## With no feature

| Tool | Who gets it | What it does |
|---|---|---|
| `skillRead` | every turn | Opens one of the agent's skills by name. The agent sees every skill's description and opens the one it needs. |
| `selfListFiles` | turns its owner wrote | Lists the files in its own folder, and which it may change. Never its memory. |
| `selfReadFile` | turns its owner wrote | Reads one of them. |
| `selfListRuns` | turns its owner wrote | Lists its own runs, newest first: the job or chat, where it came from, when, the cost, and whether it failed. |
| `selfReadRun` | turns its owner wrote | Reads one run: what started it, the answer or the error, and each step on the way. |
| `selfReadGuide` | turns its owner wrote | Reads these guides, for the version installed, so it can say what it could be given (Gmail, a channel, web pages) and how. An agent that may change itself is told to read them before saying something cannot be done, and never to ask for a secret in a chat. |

The owner is `owner` in settings, the first entry in a channel's `allowFrom`,
or the account on the dashboard. A job, a token and a visitor never
get the four self tools, because a run holds what other people said. Reading
a run counts as reading from outside, so a change after it in the same
conversation is refused.

## On a channel that names its tools

A channel's `tools` keeps a turn to the tools it names, plus the memory tools
and `skillRead`. A visitor on a web channel is a stranger and gets only what
the channel names, and `memoryWriteUserNotes` with `memoryPerUser` on. Naming a
memory or self tool there stops the agent from loading. See
[Channels](/docs/channels).
