---
title: Start
order: 1
summary: Install, run setup, and what each file it writes is for.
---

Node 22.18 or newer. Node runs your TypeScript as it is, so there is no build
step.

```sh
npm install @chloejs/core
npx chloe setup
```

Setup asks four things, each with a default, so holding Enter works. Running it
again leaves what is already there alone. `--yes` takes every default, and
`--agent <id>` names the agent. With no keyboard, which is how a coding agent
runs it, it takes the defaults.

1. **What the agent is called.** It writes the files below. If port 3067 is
   taken, most likely by another chloe, it puts this one on the next free port,
   as `serve: { port }` in `chloe.config.ts`.
2. **Which model.** It finds the `claude` and `codex` commands and any Anthropic,
   OpenAI or gateway key in your environment, takes one you paste, or offers a
   free one. Then it makes one real call to check the model answers and can call
   a tool. See [Models](/docs/models).
3. Nothing: it runs a job that asks no model, so the first thing you see is a
   finished run that cost nothing.
4. **Where to watch it from**: the dashboard on this machine, and, only if you
   want, a [remote dashboard](/docs/the-page#a-remote-dashboard) too.

There is no password to set. The dashboard opens with a link, and a password is
for later, if you want one.

## What it wrote

| File | What it is |
|---|---|
| `chloe.config.ts` | The list of agents, and every [setting](/docs/settings). An agent not on it does not run. |
| `agents/<id>/agent.ts` | The agent: its instructions, jobs, tools and channels. See [An agent](/docs/agents). |
| `agents/<id>/instructions.md` | What it is told on every turn. |
| `agents/<id>/jobs/` | Two jobs: `daily-note.ts`, code, and `summary.md`, a prompt. |
| `.env` | Every password, key and token, mode 600, never committed. |
| `AGENTS.md`, `CLAUDE.md` | Send a coding agent to these guides, which ship in the package for the version you installed. |

It also adds `"type": "module"` to `package.json`, and `node_modules`, `data`
and `.env` to `.gitignore`.

```ts file=example/chloe.config.ts
```

A key reaches chloe only where the config names it, as `process.env.` and its
name in `.env`. chloe reads nothing else from the environment.

## Run it

```sh
npx chloe                           # run everything: the dashboard, the cron lines, the channels
npx chloe link                      # a link that opens the dashboard signed in
npx chloe agent shop                # talk to an agent
npx chloe agent shop stuck-orders   # run one job now
npx chloe account                   # set a password, or a new one
npx chloe install                   # keep it running after you log out and after a reboot
```

`npx chloe` is one process on one port, and if it is down nothing runs. An edit
to an agent's files or to the config is live within a second, including a new
agent. An update to chloe itself needs a restart. `npx chloe install` makes it
a service: a systemd user unit on Linux, a launchd agent on a Mac.

`npx chloe` prints a link as it starts, `http://127.0.0.1:3067/#in=...`. Open it
in a browser on the same machine and you are in, with nothing to set: it signs
that browser in for a week, works once, and only within the hour.
`npx chloe link` prints another. From another machine, use
`ssh -L 3067:127.0.0.1:3067 you@box` and open the link there, or a
[remote dashboard](/docs/the-page#a-remote-dashboard), which needs no open port.

`npx chloe install` writes one service per machine, so on a machine already
running chloe it would move that service to this folder.

A small agent fits in one file: [One file](/examples/one-file) is a whole
project run with `node`.
