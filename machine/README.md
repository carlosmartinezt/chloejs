# The machine image

The base image for an agent in a machine of its own, and how it starts. What
each part is for, and how to run a machine from it, is `../docs/machines.md`,
which ships in the package and on chloejs.org.

- `Dockerfile`: the base image. Build it from a clone of this repo.
- `entrypoint.sh`: the machine's start, as root: hidden processes, the firewall
  that keeps the shell user to chloe's proxy, the folder rights, then chloe as
  the runtime user.
- `sudoers`: the bridge between the two users, installed as
  `/etc/sudoers.d/chloe-machine`.

The runtime's half of the machine, the `shellRun` tool and the proxy it reaches
the internet through, is `../plugins/machine/`.
