---
title: The site, the API, and the run record
order: 10
summary: What a run writes down, the dashboard and the API, reaching them from another machine, an agent's memory, and where state lives.
---

## What a run writes down

Every run, scheduled or not, records each step: what it was handed, what it
returned, how long it took and what it cost. A step that asked a model is a line
with a price on it, so a job that grew a second model call shows a second line
and a bigger number. A run that is waiting shows who was asked and until when.

A [trial run](/docs/jobs#a-trial-run) is marked a trial, and lists every
message and email it would have sent and did not.

A prompt job that chloe stopped in the middle offers to carry on from there
(`POST /api/runs/<id>/carry-on`): the model is handed what it had done, and told
which call never finished.

## The dashboard

chloe serves its own dashboard at `127.0.0.1:3067` (`serve.port` in settings),
with nothing to install. Starting it prints a link that opens the page signed
in.

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
| `/people` | inviting people, and changing or removing what they were given |

## Who may reach it

| Who | How | What they may do |
|---|---|---|
| You | a link from `npx chloe link`, or the password if you set one | everything |
| Somebody you invited | their email and their own password, from the link you sent them | only the agents they were let in to, and on each only chat, read or run as given. See [One person, and the people you invite](/docs/one-person). |
| Another system | a token, made at `/tokens` or with `npx chloe tokens make` | read the API, and chat to and run the jobs of agents with an [HTTP channel](/docs/channels-http). Never write a file, read a memory or touch the tokens. |
| Anybody | | `GET /api`, whether there is a password, signing in, signing out, and reading or taking an invitation whose link they hold |

A fresh copy has no password and opens with a link: `npx chloe` prints one as
it starts while there is no password, and `npx chloe link` prints one whenever
asked. A link signs one browser in for a week, works once, and only within the
hour. Making one reads `data/login.json`, so it takes a shell on the machine.

A password is for signing in without a link. Set the first one on the page,
under Account settings, or with `npx chloe account`, which is also how you
change it or get back in. There is no username. A token is shown once and kept
only as a hash. A token made with `--agent <id>` reaches that agent and nothing
else.

`GET /api` lists every route with a line on what it does and who may call it:
a page in a browser, JSON for anything else.

```sh
token=$(curl -s -X POST localhost:3067/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"yours"}' | jq -r .token)
curl -s localhost:3067/api/agents -H "authorization: Bearer $token"
```

## From another machine

chloe listens on loopback only unless you say otherwise, and sends nothing
anywhere you did not name: no copy of your runs, agents or memories goes to any
other dashboard. To reach the dashboard from somewhere else:

- **`npx chloe --remote`**, for a server you reach over SSH. chloe listens
  on every address and serves the page over HTTPS, with a certificate it
  makes itself and keeps in the state folder, and prints a link at the address
  your SSH session came in on. The browser says the connection is not private
  once, because nobody else signed that certificate: the fingerprint it shows
  is the one chloe printed. Plain HTTP answers only on the machine itself.
  This puts the page on the internet, guarded by the link and the password,
  and a firewall that closes the port keeps it from opening.
- **An SSH tunnel.** `ssh -L 3067:127.0.0.1:3067 you@yourbox`, then
  `127.0.0.1:3067` in your browser. Nothing is opened.
- **A private network** of your own, such as Tailscale or WireGuard, with a
  web server on the box that only it reaches.
- **Your own web server on a public name**, passing everything on to chloe's
  port. This puts the run history, the agents' files and their memories one
  password away from the internet, so use a long password. The server in front
  must pass the visitor's address on, as `cf-connecting-ip` or by adding to
  `x-forwarded-for`, and nothing but it may reach the port, or the lockout for
  wrong passwords is worth nothing. A memory file's pass works only from the
  address that asked for it, which is read the same way.

For Caddy, the whole of it is:

```
agents.example.com {
	reverse_proxy 127.0.0.1:3067 {
		flush_interval -1
	}
}
```

`flush_interval -1` lets a reply stream while the agent is still working.

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
data/login.json           the password and what signs the sessions and links, mode 600
data/tokens.json          the tokens, as hashes, mode 600
data/seen-addresses.json  where sign-ins came from, for the new-address alert
data/memory-audit/        every memory file served, one log per agent
data/memory/<id>/         what that agent keeps, with its history
```

`CHLOE_STATE` and `CHLOE_MEMORY` in `.env` move them, for when your agents live
inside a repo of your own. Git should ignore `data/`, and `git clean -x` would
delete it: do not run that in a repo that holds it.
