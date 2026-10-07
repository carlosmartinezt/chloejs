---
title: The site, the API, and the run record
order: 10
summary: What a run writes down, the site and the API in front of it, and where state lives.
---

## What a run writes down

A run shows a line per step with what it returned, what it took and what it cost,
its state as it stands, and, while it is waiting, who was asked and until when.
A step that asked a model is one of those lines with a price on it, which is how
a job that quietly grew a second model call shows up as a second line and a
bigger number.

Answering a parked job usually happens wherever the question arrived, but
`POST /api/runs/<id>/answer` with `{"text":"yes"}` does it from the site.

A job's prompt that the service stopped in the middle of offers to carry on
from there, which is `POST /api/runs/<id>/carry-on`. It continues the same run:
the model is handed what it was asked, each answer it gave and what each tool
said back, and is told which call never finished and that a long tool answer
was kept only in part.

## The site

**The runtime serves a dashboard of its own, and it needs nothing installed.**
Open `127.0.0.1:3067` in a browser and it shows which agents are loaded, what
each one is configured to do, its runs, a conversation with each, its files,
its memory, the sign-ins its connections need, the tokens, and the API docs.
It ships built inside the package, so it adds no dependency to your project.

One app on several addresses. `/` is the overview, `/agents/<id>` is one agent,
`/agents/<id>/files/<path>` is one of that agent's files or folders at the path
it has on disk, `/agents/<id>/chat` is talking to it, `/agents/<id>/log` is
its history, and `/log` is every agent's history searched together. On either
log, `?run=<id>` opens one run in a panel down the right. `/tokens` makes and
revokes tokens, and `/agents/<id>/memory` is that agent's memory.

**While you are working on the page**, `npm run dev:site` in a clone of chloejs
rebuilds `site/page/` on every edit. It serves nothing: the runtime serves that
folder, so reload the browser and the new build is what it gets.

## The API

`GET /api` is every route this runtime answers, with a line saying what each one
does and who may call it. That list is generated from the same list the router
dispatches on, so a route that is not documented is not a route. A browser gets
it as a page and anything else gets it as JSON.

```sh
curl localhost:3067/api | jq -r '.[] | "\(.method) \(.path)"'
```

## Who may call what

**The account** is somebody signed in on the box, and can do everything. There
is one password and no username, because with one account a name identifies
nobody. Set it from a shell with `npx chloe account`, which writes
`data/login.json` at mode 600 and makes one up if you would rather not think of
one. Run it again later for a new password, which is the way back in from a
forgotten one and changes nothing else. Signing in sets a cookie, which is what
a browser uses, and answers with the same value as `token` for anything that is
not one.

```sh
token=$(curl -s -X POST localhost:3067/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"yours"}' | jq -r .token)
curl -s localhost:3067/api/agents -H "authorization: Bearer $token"
```

**A token** is for another system. Make one at `/tokens`, and the secret is shown
once and never stored: what is kept is its hash, so the file leaking is not the
tokens leaking. A token may read the API, and may chat to and run the jobs of the
agents that bind an api channel. It may not write a file, read the notes, or make
and revoke tokens. Those are the account's.

**Anybody** gets four routes and no more: `GET /api`, `GET /api/account`, which
says only whether an account has been made yet, and the two that sign in. A
channel's own path is outside all of this and carries its own secret.

**The server binds loopback**, so something is always in front of it. The
simplest arrangement is no proxy at all and an SSH tunnel:

```sh
ssh -L 3067:127.0.0.1:3067 you@yourbox
```

Putting it on a public name works too, and then the one account is what stands
between the internet and everything above: the run history, the agents' folders,
and any notes an agent keeps.

Whoever is in front must pass the visitor's address on, as `cf-connecting-ip` or
by appending to `x-forwarded-for`, which is what a reverse proxy does by default.
The last entry of that list is read, not the first: every hop appends, so the
front of it is whatever the caller sent. A proxy that overwrites the whole list
instead of appending, or a port something other than the proxy can reach, both
hand the lockout to whoever is guessing.

## An agent's memory

Every agent has one: the folder it reads and writes between runs. Unsaid, it is
the agent's own folder inside `data/memory`, so the agents' folders stay source
and nothing an agent writes is inside one. `data/memory` is one
git repository, a folder per agent, so one history covers every agent: whatever a
run changes in its own folder is committed when the run ends, under the agent's
name, the folder beside it is left alone, and the run's record keeps the commit.
An agent
that shares a folder with a person says where, in its definition, with `memory`
naming the `folder`, what the site `label`s it, and when a change is a
`commit`: `"each run"`, `true` for every write, or `false`. Its memory tools,
the site, a job's `work.memory` and a script's `MEMORY_FOLDER` all read that
one place.

The dashboard shows it the way an editor shows a folder: a picker for whose
memory, the tree down the left, the files you have open as tabs across the top,
the one you are reading in the middle, and a status line. Right-click a file or
a tab for what you can do with it. When the folder is a git repository there is
source control beside the tree: what changed, commit it, push, pull, and the
recent history. Any text file has a Source view, to read it or to change it and
save, and any file has a History view: every commit that touched it, each with
its diff and an Undo. The Memory link goes back to the memory and the file you
last had open, remembered in that browser.

An agent's own page lists its changes, in its memory and in its own folder,
newest first, with the ones it made since you last looked marked and a button
to say you have. A run's page lists the commits that run made. Undo puts every
file a commit changed back how it was and commits that under the box's own git
name, and it is refused when a file has changed since, because putting it back
would lose the later change too.

Markdown, JSON and other plain text are drawn by the page itself. **Anything
else, which is mostly HTML, is shown in a sandboxed frame.** It is somebody's own HTML, it runs its
own script, and an agent may have written it from an email or a web page. So it
is served with a sandbox in its Content-Security-Policy, which gives it an origin
of its own: its script runs, so its components still draw, but it cannot reach
the page around it or call the API as you, and it cannot open a connection to
send anything out. Its own stylesheet reaches it through a pass in the address,
because a sandboxed document sends no cookie. The pass reads one agent's memory
for ten minutes and does nothing else.

The page adds a little to every HTML note: a few `ctx-` classes a note can opt
into (a card, a tag, a callout), an optional reading layout for HTML with no
stylesheet of its own, and a script that opens a link to another note as a tab.

**Every file served is written to `data/memory-audit/<agent>.jsonl` first**, and
that is the point rather than a detail. Reading the same file from a shell is not
recorded, because a shell on the box is already the whole of the box; HTTP is
the part somebody else could come through, and a log of what was served is the
only way to answer afterwards what was taken. A read that could not be recorded
is refused instead of served. Listing is recorded as well as reading, and so is
everything a frame loads. The log is one of the panels beside the tree.

Only the account may reach a memory. A token cannot, whatever it is for.

## State

Everything the box keeps lives in `data/`, beside `chloe.config.ts`: what the
runtime keeps, and what the agents keep in `data/memory`. Git should ignore
`data/` in your repo: the runtime tells that repo about the memories when it
makes them, in the repo's own `.git/info/exclude`, and one line in `.gitignore`
says it for every clone. Copying `data/` plus cloning your repo is the whole of
moving to a new machine.

```
data/agents.db            conversations and the run history
data/login.json           the one account, mode 600
data/tokens.json          the tokens, as hashes, mode 600
data/seen-addresses.json  where sign-ins have come from, for the new-address mail
data/memory-audit/        every file of an agent's memory served, one log each
data/memory/<id>/         whatever that agent decides to keep, with its history
```

It is worked out from where your repo is, so there is nothing to set, and
`CHLOE_STATE` and `CHLOE_MEMORY` in `.env` move each of them, which is what
to do when your agents are a folder inside a repo of your own. Files a setting points at, like a key
file, are not state and stay wherever that setting says. A folder outside the
repo that an agent uses, like where its backups go, is a full path written in
that agent's own file.

`git clean -x` would delete `data/`. Do not run that in a repo that holds it.
