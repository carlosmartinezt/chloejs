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
it. An agent says it runs in one with `workspace.sandbox` in its agent.ts. The
machine's config says so with `machine.own` in settings, and the shell
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

## Running an agent in one

Say so in the agent's own `agent.ts`, and list it in `chloe.config.ts` like
any other agent:

```ts
export default defineAgent({
  id: "builder",
  model: "anthropic/claude-sonnet-5",
  purpose: prompt("purpose.md"),
  abilities: { shell: true },
  workspace: {
    sandbox: { type: "podman", image: "./machine/Dockerfile" },
  },
});
```

Your copy of chloe does not run it. It makes the machine, keeps it as the
definition says, and shows the agent on its page with the others:

- builds the image from the Dockerfile, as `chloe-<id>:<hash>`, and again
  when the file or the base image changes;
- makes the container `chloe-<id>`, with the volumes `chloe-<id>-data` (its
  memory, runs and keys) and `chloe-<id>-work` (its work), on a free port on
  loopback, from your own port plus 100;
- lends it the agent's folder at `workspace/routines`, so an edit you make is
  live in the machine at once;
- writes the machine's config and `.env`: your copy's settings, all but
  `serve` and `machine`, and of `agents` only this agent's own, each secret
  read from its `.env` under the name it has in yours; the names in
  `machine.keys` and in the sandbox's `keys`; and a key that makes your copy
  its owner, kept in your state folder as `machines/<id>.key`;
- runs the sandbox's `setup` script inside it, and starts it.

It does all of that again, keeping the volumes, when anything the machine is
made from changes, and only starts it when nothing has. Nothing about the
machine is written by hand: no port, no key, no command.

| In `sandbox` | What it is |
|---|---|
| `type` | `"podman"` or `"docker"`. Required. |
| `image` | A Dockerfile, as a path from the agent's folder, starting `FROM chloe-machine`; or an image's name. Default: `machine.image`. |
| `lend` | Files and folders of this computer the machine sees at the same path, each `"read"` or `"write"`. |
| `env` | Plain values for the machine's environment, like where a lent file is. |
| `keys` | Names in your `.env` it is also given, under the same name. |
| `setup` | A script in the agent's folder, run in the machine as chloe's user each time the machine is made: a clone, a package install. |

`workspace.filesystem` says where the work is kept: `{ type: "volume" }`, the
default, or `{ type: "local", path: "/srv/work" }`, a folder of this computer.

The agent's folder is read only in the machine, unless it is a git repository
of its own, when the machine may change it and a self change is a commit
there, as it is here. A folder inside your project's repository is changed
from your computer. Anything lent for writing, or a folder that is its own
repository, makes the machine's runtime user you, on this computer (Podman's
`keep-id`), so it can write there.

## The base image

`machine/Dockerfile` builds it: Node, git, the runtime, the two users, the
sudoers line and the start script. The first machine your copy makes builds it
from the installed package, as `chloe-machine`. To build it again after the
runtime changes, from a clone:

```sh
git clone https://github.com/carlosmartinezt/chloejs
cd chloejs
podman build -t chloe-machine -f machine/Dockerfile .
```

or in a project that installed the package:

```sh
podman build -t chloe-machine -f node_modules/@chloejs/core/machine/Dockerfile node_modules/@chloejs/core
```

A clone runs chloe from its source; the package runs its build. Both are the
same image, and every agent's own image is built again on top of it.

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
adds it in its own Dockerfile, one line at a time, named as `image` in its
sandbox:

```dockerfile
FROM chloe-machine
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg
```

Nothing an agent installs this way reaches the `runtime` user's files, whatever
the tool does: the users, not the packages, are the boundary.

## Making one from the page

The page's **New agent** (on All agents) makes an agent and says where it
runs: **This computer**, a folder in `agents/` listed in `chloe.config.ts`
with no shell, or **A container**, the same folder with a `workspace` of
`{ sandbox: { type: "podman" } }` (or docker), the shell on, and the folder a
git repository of its own, so the agent can change itself in its machine. No
model is asked anything: the same form makes the same agent, and the agent
changes itself into what you ask for once you talk to it. It answers once the
machine lists the agent.

`POST /api/agents` does the same for a program, and `GET /api/places` says
where an agent can be made here and why one cannot.

## On your page

Everything about an agent in a machine (its chat, runs, memory, files and
jobs) is asked of the machine, which keeps its runs and writes every memory
file it serves to its own audit log, with your address, before serving it.
The frame a memory file is shown in is served by your own copy, sandboxed as
always. While its machine is being made, the page says so.

You reach it as yourself. A token of your copy's reaches it as a token: your
copy refuses what no token may do and a token made for another agent, and the
machine applies its own rules for tokens (the agent has to bind an api channel
to be chatted to). Somebody invited to your copy is nobody in the machine. When
the machine does not answer, the agent stays on the list saying so. The key
your copy keeps reaches everything the machine's login does, and is for your
own copy of chloe and nothing else.

A machine that has stopped is started again when it is asked for, and a
minute or two before one of the agent's jobs is due, from the jobs the machine
last said it has. Under systemd it is started in a scope of its own, so
restarting your copy does not stop it.

## Sleeping between uses

A machine your copy makes never stops by itself. `serve.stopAfter`, in the
config of a copy that runs in a machine, is the idle minutes before it stops
itself (no request over its port, no run going or waiting, no job due in the
next five minutes), for a machine that costs money while it runs; your copy
starts it again as above. A copy whose agent binds a channel other than api
never stops, because that channel listens for messages.

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
