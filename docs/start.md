---
title: Start
order: 1
summary: Install, run setup, and what each file it writes is for.
---

Node 22.18 or newer. Node runs your TypeScript as it is, so there is no build
step. `command not found: npx` means Node is not installed: on a Mac, take the
installer from [nodejs.org](https://nodejs.org).

```sh
npm install @chloejs/core
npx chloe setup
```

Setup asks two things, each with a default, so holding Enter works. Running it
again leaves what is already there alone. `--yes` takes every default. With no
keyboard, which is how a coding agent runs it, it takes the defaults.

It writes the files below, with a first agent, and installs `typescript` and
`@types/node` with the package manager your project already uses. If port 3067
is taken, most likely by another chloe, it puts this one on the next free port,
as `serve: { port }` in `chloe.config.ts`.

1. **Which model.** It finds the `claude` and `codex` commands and any Anthropic,
   OpenAI or gateway key in your environment, takes one you paste, or offers a
   free one. Then it makes one real call to check the model answers and can call
   a tool. See [Models](/docs/models).
2. **A git repository.** In a folder that is not one, it makes one and commits
   what is there, under your git name, or "npx chloe setup" when git has none.
   Every change an agent makes to itself is a commit you can read and undo, and
   what you changed by hand in a file it changes is committed first, under
   your name. In a repository of your own setup commits nothing. It never
   installs git.

## The first agent

Setup writes one, `agents/assistant`, with instructions and nothing else. Run
`npx chloe`, open the link it prints, and tell it what you want done: it changes
itself to do it, its words, its jobs and its code, and each change is a commit
you can read and undo on the dashboard. See
[What an agent may change about itself](/docs/prompts#what-an-agent-may-change-about-itself).

Or ask your coding agent, in the project's folder, for what you want done, like
"an agent that tells me every morning at 7 what is most urgent in my mail". It
reads these guides, which ship in the package for the version installed, and
makes the first agent into that one, or writes another and lists it in
`chloe.config.ts`.

There is no password to set. The dashboard opens with a link, and a password is
for later, if you want one.

## What it wrote

| File | What it is |
|---|---|
| `chloe.config.ts` | The list of agents, with the first one on it, and every [setting](/docs/settings). An agent not on it does not run. |
| `agents/assistant/` | The first agent: `agent.ts`, which says what it is, and `instructions.md`, its words. Only a config setup writes gets one, because that config is what lists it. |
| `.env` | Every password, key and token, mode 600, never committed. |
| `tsconfig.json` | How your editor and `tsc` read the project's TypeScript. Node runs it as it is, so nothing is compiled. Setup also installs `typescript` and `@types/node`: chloe runs without them, but then an agent's change to its own code is not type checked before it goes live. |

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
`npx chloe link` prints another. On a server you reach over SSH, start it with
`npx chloe --remote` instead, and the link opens on your own computer: see
[From another machine](/docs/the-page#from-another-machine).

`npx chloe install` writes one service per machine, so on a machine already
running chloe it would move that service to this folder.

A small agent fits in one file: [One file](/examples/one-file) is a whole
project run with `node`.
