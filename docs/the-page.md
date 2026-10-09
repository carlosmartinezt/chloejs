---
title: The site, the API, and the run record
order: 10
summary: What a run writes down, the dashboard and the API, a remote dashboard and what it may do, an agent's memory, and where state lives.
---

## What a run writes down

Every run, scheduled or not, records each step: what it was handed, what it
returned, how long it took and what it cost. A step that asked a model is a line
with a price on it, so a job that grew a second model call shows a second line
and a bigger number. A run that is waiting shows who was asked and until when.

A prompt job that chloe stopped in the middle offers to carry on from there
(`POST /api/runs/<id>/carry-on`): the model is handed what it had done, and told
which call never finished.

## The dashboard

chloe serves its own dashboard at `127.0.0.1:3067`, with nothing to install.

| Address | What it shows |
|---|---|
| `/` | every agent, at a glance |
| `/agents/<id>` | one agent: what it is set up to do, its jobs, channels and connections |
| `/agents/<id>/chat` | talking to it |
| `/agents/<id>/log` | its runs; `?run=<id>` opens one |
| `/agents/<id>/files/<path>` | its own files |
| `/agents/<id>/memory` | its memory |
| `/log` | every agent's runs, searched together |
| `/tokens` | making and revoking tokens |

## Who may reach it

| Who | How | What they may do |
|---|---|---|
| You | the one password, set with `npx chloe account` | everything |
| Another system | a token, made at `/tokens` or with `npx chloe tokens make` | read the API, and chat to and run the jobs of agents with an [HTTP channel](/docs/channels#http). Never write a file, read a memory or touch the tokens. |
| Anybody | | four routes: `GET /api`, whether an account exists, and signing in |

There is one password and no username. Run `npx chloe account` again for a new
one, which is also how you get back in. A token is shown once and kept only as
a hash. A token made with `--agent <id>` reaches that agent and nothing else.

`GET /api` lists every route with a line on what it does and who may call it:
a page in a browser, JSON for anything else.

```sh
token=$(curl -s -X POST localhost:3067/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"yours"}' | jq -r .token)
curl -s localhost:3067/api/agents -H "authorization: Bearer $token"
```

**Reaching it from another machine.** chloe listens on loopback only. The
simplest way in is an SSH tunnel, `ssh -L 3067:127.0.0.1:3067 you@yourbox`, then
`127.0.0.1:3067` in your browser. Putting it on a public name puts the run
history, the agents' files and their memories one password away from the
internet. If you do, the proxy in front must pass the visitor's address on, as
`cf-connecting-ip` or by adding to `x-forwarded-for`, and nothing but the proxy
may reach the port, or the lockout for wrong passwords is worth nothing.

## A remote dashboard

To watch it from anywhere without opening a port, make a workspace on
[dashboard.chloejs.org](https://dashboard.chloejs.org), or on a dashboard of
your own, and put the key it shows you once in `.env` as
`CHLOE_DASHBOARD_REMOTE_API_KEY`. The config hands it over as
`dashboard: { remote: { api_key: process.env.CHLOE_DASHBOARD_REMOTE_API_KEY } }`.
chloe connects out to it and stays connected. Nothing about how jobs run
depends on it, and taking the key out leaves everything running as it was.

It is for you and the people you invite, never the public: a web page's chat
box reaches chloe through your own server, not the dashboard.

| Setting | Default | What it controls |
|---|---|---|
| `dashboard.remote.api_key` | none | The workspace key. Without it there is no connection. |
| `dashboard.remote.url` | `https://dashboard.chloejs.org` | Where the dashboard is. |
| `dashboard.remote.upload.runs` | on | Each run's facts as it starts and ends: when, which job, the model, the steps, the cost, the error. Never what was said. |
| `dashboard.remote.upload.replies` | off | With `runs`, each run's reply and summary too. |
| `dashboard.remote.upload.agents` | on | Each agent's configuration. |
| `dashboard.remote.allow.read` | on | It may read the agents, runs, files and conversations. |
| `dashboard.remote.allow.chat` | on | It may talk to an agent. |
| `dashboard.remote.allow.run` | on | It may run a job now. |
| `dashboard.remote.allow.memory` | off | It may read a memory. Every file is still logged first. |
| `dashboard.remote.allow.write` | off | It may write a file, a memory, an answer to a waiting job, a model pick. |
| `dashboard.remote.allow.google` | off | It may finish a Google sign-in for you. See [Connections](/docs/connections#google). |

A remote dashboard also takes WhatsApp deliveries for you and gives the email
channel its addresses: see [Channels](/docs/channels).

## An agent's memory

Every agent has a memory folder, `data/memory/<id>/` unless its `memory` says
otherwise (see [An agent](/docs/agents#memory)). `data/memory` is one git
repository, a folder per agent: what a run changes in its own folder is
committed when the run ends, under the agent's name, and the run lists the
commit.

The dashboard shows a memory the way an editor shows a folder: the tree, open
files as tabs, and beside it what changed, with commit, push and pull. Every
file has a History view with each commit's changes and an Undo. Undo is refused
when the file has changed since, because putting it back would lose the later
change. An agent's page lists its changes newest first, with the ones since you
last looked marked.

**A memory file other than plain text is shown in a sandboxed frame.** It may
be HTML an agent wrote from an email or a web page, so it runs in a sandbox: its
own script runs, but it cannot reach the dashboard around it, call the API as
you, or send anything out.

**Every file served is logged first**, in `data/memory-audit/<agent>.jsonl`, and
a read that could not be logged is refused. Listing a folder is logged too.
Reading the same file from a shell on the machine is not, because a shell is
already the whole machine. Only you can reach a memory; a token cannot.

## State

Everything chloe keeps is in `data/`, beside `chloe.config.ts`. Copying `data/`
and cloning your repo is the whole of moving to a new machine.

```
data/agents.db            conversations and the run history
data/login.json           the password, mode 600
data/tokens.json          the tokens, as hashes, mode 600
data/seen-addresses.json  where sign-ins came from, for the new-address alert
data/memory-audit/        every memory file served, one log per agent
data/memory/<id>/         what that agent keeps, with its history
```

`CHLOE_STATE` and `CHLOE_MEMORY` in `.env` move them, for when your agents live
inside a repo of your own. Git should ignore `data/`, and `git clean -x` would
delete it: do not run that in a repo that holds it.
