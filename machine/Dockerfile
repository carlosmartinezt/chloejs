# The base image for an agent in a machine of its own: one agent, its workspace,
# and two Linux users. docs/machines.md says what each user owns, how to run a
# machine from this image, and what the firewall can and cannot do.
#
# Build it from a clone of this repo:
#
#   podman build -t chloe-machine -f machine/Dockerfile .
#
# or from the installed package in a project:
#
#   podman build -t chloe-machine -f node_modules/@chloejs/core/machine/Dockerfile node_modules/@chloejs/core
#
# The first runs chloe from its source, the second from the package's build.
# Either way an agent that needs a tool this image has not got adds a line on
# top of it, in its own Dockerfile: see "Adding a tool" in docs/machines.md.
FROM node:22-bookworm-slim

# git for clones, curl for checking the things a routine watches, ca-certificates
# for anything that reaches an https host, iptables for the wall that keeps the
# shell user to chloe's proxy, sudo for the bridge between the two users.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates iptables sudo \
 && rm -rf /var/lib/apt/lists/*

# The runtime, from this clone, run from its source.
COPY . /home/runtime/chloe
RUN cd /home/runtime/chloe \
 && npm ci --no-audit --no-fund \
 && npm run build:site \
 && npm prune --omit=dev

# Two users. runtime runs chloe and owns everything private: its data folder,
# its .env, the routines. shell runs the agent's commands and owns the workspace
# folders it makes there, and nothing else. runtime is 1000, the uid a machine
# that writes on its host maps the host's user to (plugins/machine/make.ts).
RUN userdel -r node 2>/dev/null || true \
 && useradd -m -u 1000 runtime \
 && useradd -m -u 1001 -s /bin/bash shell \
 && chown -R runtime:runtime /home/runtime/chloe \
 && chmod 755 /home/runtime

# The bridge: chloe's own user may run anything as the shell user, and only as
# the shell user.
COPY machine/sudoers /etc/sudoers.d/chloe-machine
RUN chmod 440 /etc/sudoers.d/chloe-machine

# The machine's home is the project chloe runs in: chloe.config.ts and .env at
# the top, written when a machine is made. data/ is the runtime's own, with the
# run history, the keys and the agent's memory, and the shell user cannot read
# it. workspace/ is where the shell works, sticky like /tmp: the shell user can
# make folders there, but cannot remove routines, which is chloe's own and
# readable by the shell user and never writable by it.
RUN mkdir -p /home/runtime/data /home/runtime/workspace/routines \
 && chown runtime:runtime /home/runtime /home/runtime/data /home/runtime/workspace/routines \
 && chmod 755 /home/runtime \
 && chmod 700 /home/runtime/data \
 && chmod 755 /home/runtime/workspace/routines \
 && chmod 1777 /home/runtime/workspace

# The machine's config and its agent import the runtime by name, the way any
# project does: node_modules/@chloejs/core is the clone itself. An agent's code
# also imports zod and the AI SDK, which a project installs beside the runtime,
# so they are the runtime's own copies.
RUN mkdir -p /home/runtime/node_modules/@chloejs \
 && ln -s /home/runtime/chloe /home/runtime/node_modules/@chloejs/core \
 && ln -s /home/runtime/chloe/node_modules/zod /home/runtime/node_modules/zod \
 && ln -s /home/runtime/chloe/node_modules/ai /home/runtime/node_modules/ai

COPY machine/entrypoint.sh /usr/bin/machine-entrypoint
RUN chmod 755 /usr/bin/machine-entrypoint

WORKDIR /home/runtime
ENTRYPOINT ["/usr/bin/machine-entrypoint"]
