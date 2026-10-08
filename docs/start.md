---
title: Start
order: 1
summary: One command writes the files, picks a model and runs a job. Then the three files it wrote.
---

Node 22.18 or newer. Node runs your TypeScript directly, so there is no build
step in your project and nothing of yours is compiled.

```sh
npm install @chloejs/core
npx chloe setup
```

`setup` is the one command that runs before there is a project, because writing
one is what it does. Every answer has a default, so holding Enter through it
works, and running it again leaves whatever is already there alone.
`--yes` takes every default without asking, and `--agent <id>` names the first
agent. With no keyboard, which is how a coding agent runs it, it takes the
defaults by itself and leaves the password for `npx chloe account`.

It asks five things:

1. **What your first agent is called.** It writes `chloe.config.ts`, that agent's
   folder with two jobs in it, `"type": "module"` in your `package.json`, the
   lines a `.gitignore` needs, and an `AGENTS.md` (with a `CLAUDE.md` that reads
   it) sending a coding agent to these guides, which the package carries for
   the version you installed.
2. **Which model.** It finds the `claude` and `codex` commands and any
   Anthropic, OpenAI or gateway key already in your environment, takes one you
   paste, and offers a free one when there is none. Then
   it makes one real call and says whether that model answered and whether it can
   call a tool. [Models](/docs/models) is the longer version.
3. Nothing: it runs the job that asks no model, so the first thing you see is a
   finished run. Three steps, nothing spent, and a line in that agent's memory.
4. **Where you want to watch it from**: a workspace on Chloe Cloud, or the
   dashboard on that machine, both in [the site](/docs/the-page).
5. **The one password**, which is what the page asks for and what
   `npx chloe agent` signs itself in with.

That is the runtime: the API, the cron lines, the channels, and a small site of
its own showing what is loaded.

What it wrote, and what each file is for.

**One.** `chloe.config.ts` at the top of your repo. An agent is declared, never
found: this file is the list, and an agent that is not on it does not exist. It
is also where every setting goes, because a setting is a choice about how the
runtime behaves and this file is already the one that says what this copy is.
Every default and its one line of explanation is in the schema, so the file is
only what you have changed.

```ts file=example/chloe.config.ts
```

**Two.** The agent itself. Its `agent.ts` is the whole list of what it is: its
instructions, its jobs, the tools it hands a model, the channels it is reached
on. Nothing is read from a folder except `skills/`, so a job that is written and
not imported does not run, and the tests say so. The one setup writes is smaller
than this, which is the shop this site's examples come from.

```ts file=example/agent.ts
```

`id` is what the run history and the agent's own notes are filed under, so it
does not change once the agent has run. `label` is what the page calls it and is
free to change. An agent with no `model` line asks `model.defaultModel` below, which is
why the one setup writes has none: the model you chose is written down once, for
every agent.

**Three.** `.env` beside the config, mode 600 and out of source control. Every
password, key and token, and nothing else.

```
CHLOE_MODEL_KEY=...
CHLOE_AGENTS_SHOP_TELEGRAM=123456:ABC...
```

A key reaches chloe only where the config names it, as `process.env.` and its
name here, which is why the config above has those lines. Every other setting
has a name here too, `CHLOE_` and its path in capitals, and what is here beats
what the config declares. [Settings](/docs/settings) is the longer version.

Then run it:

```sh
npx chloe                           # the one process: the site, the cron lines, the channels
npx chloe agent shop                # talk to it
npx chloe agent shop stuck-orders   # run one job now, without waiting for its cron line
npx chloe account                   # a new password, whenever you want one
```

`npx chloe` is one process on one port. It serves the site, answers the API,
keeps every cron line and answers the channels, and if it is down nothing fires.
It watches each agent's folder, so an edit to a job is live in under a second,
including a brand new agent folder. A change to the runtime itself needs a
restart.

To keep it running after you close the terminal, `npx chloe install` makes it a
service and starts it: a systemd user unit on Linux, a launchd agent on a Mac.
Nothing in it needs editing first: it works out where it is.

It binds loopback and is meant to stay there. Open `127.0.0.1:3067` in a browser
on the box, or reach it from elsewhere with `ssh -L 3067:127.0.0.1:3067 you@box`.
Putting it on a public name puts the run history, the agents' folders and every
token one password away from the internet.

To watch it from anywhere without opening a port, make a workspace on
[dashboard.chloejs.org](https://dashboard.chloejs.org) and put the key it shows
you once in `.env`, beside `chloe.config.ts`, which is the fourth question above:

```sh
CHLOE_DASHBOARD_REMOTE_API_KEY=chl_workspace_...
```

The config hands it over as
`dashboard: { remote: { api_key: process.env.CHLOE_DASHBOARD_REMOTE_API_KEY } }`,
and setup writes both. The runtime connects out to it and stays connected. The
config names the variable and never holds the key.

A small agent does not need the three files: [One file](/examples/one-file) is the
whole project in one `.ts` file, run with `node`.
