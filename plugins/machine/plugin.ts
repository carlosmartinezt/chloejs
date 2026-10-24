// The machine: a container or virtual machine with one agent, a shell user to
// run what it builds, and the proxy that is the shell's only way out. The
// image that makes the two users, the sudoers line and the entrypoint is the
// machine/ folder of the repo, and docs/machines.md says how it all fits.
import { statSync } from "node:fs";

import { settings } from "#chloe/core/settings";
import type { Plugin } from "#chloe/load/plugin";
import { shellRun, workspaceFolder } from "./tools.ts";

declare module "#chloe/load/abilities" {
  interface Abilities {
    /**
     * Adds the tool `shellRun`, which runs a shell command in the machine's
     * workspace as the shell user, through the proxy chloe runs for it. Off by
     * default.
     *
     * Only in a machine of its own (`machine.own`): on a shared computer the
     * shell is the whole computer. Refused for the rest of a reply once a tool
     * that reads from outside has answered in it, so a crafted mail cannot ask
     * for a command that carries the notes away. Its own output does not count
     * as from outside, so two commands in one reply are fine.
     */
    shell?: boolean;
  }
}

declare module "#chloe/core/settings" {
  interface MachineSettings {
    /**
     * True when this chloe runs in a machine of its own: a container or a
     * virtual machine with only this agent, made by the image in the
     * machine/ folder of the repo (see docs/machines.md). The machine's
     * config sets it. Default: false, because on a shared computer nothing
     * keeps the agent's shell away from everything else, and the shell
     * ability refuses to load.
     */
    own: boolean;
    /**
     * The Linux user the agent's shell commands run as. The machine's image
     * makes this user, and the sudoers line that lets chloe's own user run
     * commands as it. Default: "shell".
     */
    user: string;
    /**
     * The folder the shell works in, one folder per piece of work, owned by
     * the shell user. Default: "" (the workspace folder in the home folder
     * of the user chloe runs as, which the machine's image makes).
     */
    workspace: string;
    /**
     * The hosts the shell may reach, through the proxy chloe runs for it on
     * loopback. The proxy holds no key, so the shell cannot push or upload
     * anywhere, and nothing outside this list. A leading `*.` stands for
     * every host under it. Default: GitHub, npm's and PyPI's registries, and
     * Debian's package servers.
     */
    hosts: string[];
  }
}

/** The hosts a machine's shell may reach when nobody says otherwise. */
const HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "deb.debian.org",
  "security.debian.org",
];

export const machine: Plugin = {
  name: "machine",
  settings: {
    defaults: { machine: { own: false, user: "shell", workspace: "", hosts: HOSTS } },
  },
  abilities: [
    {
      name: "shell",
      label: "Shell",
      on: false,
      does: "Runs shell commands in the machine's workspace, as the machine's shell user, through the proxy chloe runs for it.",
      tools: ["shellRun"],
      make: () => ({ shellRun: shellRun() }),
      check(_home, _values, where) {
        if (!settings.machine.own) {
          throw new Error(
            `${where} has abilities.shell on, but this chloe is not in a machine of its own (machine.own in chloe.config.ts is off). ` +
              "On a shared computer the shell is the whole computer.",
          );
        }
        const workspace = workspaceFolder();
        let there = false;
        try {
          there = statSync(workspace).isDirectory();
        } catch {
          there = false;
        }
        if (!there) {
          throw new Error(
            `${where} has abilities.shell on, and no workspace folder at ${workspace}, which the shell user owns. ` +
              "The machine's image makes it: see docs/machines.md.",
          );
        }
      },
    },
  ],
};
