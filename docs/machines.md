---
title: Machines
order: 11.5
summary: An agent in a machine of its own: a container or a small virtual machine with one agent, a shell to build and try what it writes, and the two Linux users that keep what it builds away from what it knows.
---

# Machines

An agent that writes code to run your routines needs somewhere to run it: to
clone a repository, install what it needs, try the build. On a shared computer
that place is the whole computer, so chloe gives an agent a shell only in a
machine of its own: a container, or a small virtual machine, with one agent in
it. The machine's config says so with `machine.own` in settings, and the shell
ability refuses to load anywhere else: on a shared computer the shell is the
whole computer, and no boundary in chloe holds that.

## The two users

Everything inside a machine is one of two Linux users, and that split is the
whole boundary: what a command runs as cannot read what chloe holds, and the
kernel holds it.

| User | Runs | Owns and may change | May read |
|---|---|---|---|
| `runtime` | chloe itself, and the agent's jobs | `data/` (run history, keys, the agent's memory), `.env`, the routines | everything it owns |
| `shell` | every command the agent runs (`shellRun`) | the folders it makes in `workspace/` | the routines, its own home |

chloe runs the agent's commands as the `shell` user through sudo, with an
environment built in the tool and nothing inherited from chloe: no key, no
token, nothing else chloe holds reaches a command. The machine's image carries
the one sudoers line that allows it.

## The layout

```
/home/runtime/chloe.config.ts   the machine's config, written when a machine is made
/home/runtime/.env              its keys, read by that config
/home/runtime/chloe/            the runtime itself
/home/runtime/data/             run history, the account, the tokens, and memory/: the agent's memory
/home/runtime/workspace/        the agent's work, one folder each, made by shellRun
/home/runtime/workspace/routines/   the agent itself: agent.ts, purpose, skills, jobs
```

The machine's home is the project chloe runs in, so the agent is
`workspace/routines/agent.ts` in the config. `workspace/` is sticky, like `/tmp`:
the `shell` user can make folders there, but cannot remove `routines`, which is
the `runtime` user's and readable by the shell user and never writable by it.
Clones and loose code are scratch: a routine never depends on a workspace folder
surviving, and everything that matters is committed somewhere you own.

## The base image

`machine/Dockerfile` builds it: Node, git, the runtime, the two users, the
sudoers line and the start script. From a clone:

```sh
git clone https://github.com/carlosmartinezt/chloejs
cd chloejs
podman build -t chloe-machine -f machine/Dockerfile .
```

In a project that installed the package, the same image builds from the package
itself, with no clone:

```sh
podman build -t chloe-machine -f node_modules/@chloejs/core/machine/Dockerfile node_modules/@chloejs/core
```

A clone runs chloe from its source; the package runs its build. Both are the
same image.

Run it with the two capabilities the start script needs, and a volume for what
should survive the machine's disk:

```sh
podman run --detach --name journal \\
  --cap-add=NET_ADMIN --cap-add=SYS_ADMIN \\
  --publish 3067:3067 \\
  --volume journal-data:/home/runtime/data \\
  chloe-machine
```

A machine runs one agent. To make one, write its files into
`workspace/routines/` (an `agent.ts`, a purpose, whatever it needs), then a
config like this at `/home/runtime/chloe.config.ts`, and its keys in `.env`
beside it:

```ts
import { defineConfig } from "@chloejs/core";

import journal from "./workspace/routines/agent.ts";

export default defineConfig({
  agents: [journal],
  settings: {
    machine: { own: true },
    serve: { host: "0.0.0.0", port: 3067 },
    model: { key: process.env.CHLOE_MODEL_KEY },
  },
});
```

`serve.host` is `0.0.0.0` because the machine's own port is behind whatever
fronts it, and nothing else can reach it.

## The shell

`abilities: { shell: true }` adds `shellRun`: one shell command, run in the
workspace as the `shell` user, with a `folder` for the piece of work, made if
missing and shared by every command that names it. What it returns is the
command's exit code and both its outputs.

A shell command is refused for the rest of a reply once a tool that reads from
outside the agent has answered in it, the way a change to the agent is: what it
read could be asking for the command. The owner's next message starts clean, and
the shell's own output does not count as from outside, so two commands in a row
are fine.

The command reaches the internet only through the proxy below. A host not on
the machine's list fails, and so does anything that tries to read the agent's
memory, its keys, or the routines as writable: those belong to the `runtime`
user.

## The proxy

chloe runs a proxy on loopback, and the shell's environment points at it. It
carries only the hosts in `machine.hosts`, and it holds no key and adds no
credentials, so what the shell runs cannot push or upload anywhere you did not
name. A leading `*.` stands for every host under it.

```ts
settings: { machine: { hosts: [
  "github.com", "api.github.com", "codeload.github.com",
  "objects.githubusercontent.com", "raw.githubusercontent.com",
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org",
  "deb.debian.org", "security.debian.org", "my-registry.example",
] } }
```

The default list is GitHub, npm's and PyPI's registries, and Debian's package
servers. Saying `hosts` replaces the whole list, so an owner adding their own
registry writes the default names and theirs. A change holds on the next
command, with no restart.

The machine's start script also stops the `shell` user reaching the internet
any other way, with firewall rules. Where it could not (a rootless container
takes the rules and never applies them, and no kernel today offers another way),
the machine says so in its log, and the proxy is the only way out that
well-behaved tools take, not the only way there is. A machine whose log says
the firewall did not hold should not hold anything you would not hand a
stranger's program.

## Adding a tool

The image carries Node, git and the runtime. An agent whose work needs more
adds it in its own Dockerfile, one line at a time:

```dockerfile
FROM chloe-machine
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg
```

Nothing an agent installs this way reaches the `runtime` user's files, whatever
the tool does: the users, not the packages, are the boundary.

## Seeing it on your own page

A machine runs a copy of chloe of its own, with its own page and login. To see
its agent on the page you already use, beside your other agents, give the
machine an owner key and name the agent in your own copy's config.

In the machine's config, the key it takes as its owner:

```ts
settings: {
  machine: { own: true },
  serve: { host: "0.0.0.0", port: 3067, ownerKey: process.env.CHLOE_SERVE_OWNER_KEY },
}
```

In your own copy's config, where the agent runs and that key, by the agent's id,
and the agent left out of `agents`, since it runs there and not here:

```ts
settings: {
  serve: {
    elsewhere: {
      journal: { address: "http://127.0.0.1:3167", key: process.env.CHLOE_SERVE_ELSEWHERE_JOURNAL_KEY },
    },
  },
}
```

The two `.env` files hold the same long key. Your page then lists the agent with
the rest, and everything about it (its chat, runs, memory, files and jobs) is
asked of the machine, which keeps its runs and writes every memory file it
serves to its own audit log, with your address, before serving it. The frame a
memory file is shown in is served by your own copy, sandboxed as always.

Only you reach it from your page: a token or somebody invited there is nobody
in the machine. When the machine does not answer, the agent stays on the list
saying so. The owner key reaches everything the machine's login does, and is
for your own copy of chloe and nothing else.

## Sleeping between uses

A machine that is not working costs only its disk, so a machine can stop itself
when there is nothing to do and be started again when it is wanted. In the
machine's config, the minutes with nothing to do before it stops:

```ts
serve: { host: "0.0.0.0", port: 3067, ownerKey: process.env.CHLOE_SERVE_OWNER_KEY, stopAfter: 15 },
```

Nothing to do means no request over its port, no run going or waiting for an
answer or a time, and no job due in the next five minutes. A machine whose agent
binds a channel other than api never stops, because that channel listens for
messages, and it says so as it starts.

In your own copy's config, the command that starts it again, beside its
address:

```ts
journal: { address: "http://127.0.0.1:3167", key: process.env.CHLOE_SERVE_ELSEWHERE_JOURNAL_KEY, start: ["podman", "start", "journal"] },
```

Your copy runs it when the machine is asked for and does not answer, which is
what opening your page does, and waits up to a minute for it to answer. It also
runs it a minute or two before one of the agent's jobs is due, from the jobs the
machine last said it has, so the job runs on time. When your copy starts and
does not know them yet, it wakes the machine once to ask. While your page is
open it asks every twenty seconds, so an open page keeps the machine awake.

When your copy runs as a systemd service, start the machine outside the
service's own group of processes, or restarting your copy kills the
container's monitor with it and leaves Podman unable to start it again:

```ts
start: ["systemd-run", "--user", "--scope", "--quiet", "podman", "start", "journal"],
```

## What is true and what is not

A container shares its host's kernel, so code inside it is one escape from
everything on the host. That is fine for your own agents on your own machine,
and it is why a machine that runs a stranger's agent should be a virtual
machine, where the whole kernel is theirs alone.

What holds either way, because the kernel holds it rather than chloe: a command
cannot read `data/`, `.env`, the tokens or the memory, cannot change the
routines, cannot see chloe's processes (where the image could remount `/proc`),
and reaches nothing of any other folder on the host. What chloe holds by its own
rules: the proxy's list, and the refusal of a shell command after reading from
outside. Both are code, and both are on every machine, whatever it runs on.
