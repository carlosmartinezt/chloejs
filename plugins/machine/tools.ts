// The shell tool: one command, run as the machine's shell user in the
// workspace that user owns, through the proxy chloe runs for it.
//
// Everything else in chloe runs commands as chloe's own user, and no service
// ever takes a shell string. This tool is the deliberate exception to both,
// and it exists only in a machine of its own (`machine.own`): there the shell
// user owns the workspace and nothing else, so a command cannot reach the
// agent's own folder, its memory, or any key, and the shell is refused for the
// rest of a reply once something from outside has been read in it.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { settings } from "#chloe/core/settings";
import { machineProxy } from "./proxy.ts";

/** The path the machine's image gives the shell user's tools. */
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** How much of each of a command's two outputs the model is given. */
const MAX_OUTPUT = 80_000;

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n...[cut here, ${text.length} bytes in total]` : text;
}

/** Where the shell works: the workspace, or the machine's setting for it. */
export function workspaceFolder(): string {
  return settings.machine.workspace || join(homedir(), "workspace");
}

/**
 * A folder the model named, inside the workspace. Throws when it is not a
 * plain folder name, so no input can escape the workspace or reach the
 * runtime's own files through `..` or an absolute path.
 */
function insideWorkspace(folder: string): string {
  for (const part of folder.split("/")) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === "." || part === "..") {
      throw new Error(`folder is a name inside the workspace, like "saveyourchess", not ${JSON.stringify(folder)}.`);
    }
  }
  return join(workspaceFolder(), folder);
}

/**
 * Runs one shell command as the machine's shell user and waits for it.
 * Returns what `run` in the run service returns. It does not throw when the
 * command fails: check `exitCode`.
 */
async function runShell(command: string, folder: string | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const machine = settings.machine;
  const where = folder ? insideWorkspace(folder) : workspaceFolder();
  const proxy = `http://127.0.0.1:${await machineProxy()}`;
  const script = `mkdir -p "$F" && cd "$F"\n${command}`;
  // The command's environment is built here, not inherited: no key, no token
  // and nothing else chloe holds reaches the shell user. sudo resets what it
  // passes anyway, and env carries only these lines to bash.
  const carries = [
    `F=${where}`,
    `HOME=/home/${machine.user}`,
    `PATH=${PATH}`,
    `http_proxy=${proxy}`,
    `https_proxy=${proxy}`,
    `no_proxy=localhost,127.0.0.1`,
    `HTTP_PROXY=${proxy}`,
    `HTTPS_PROXY=${proxy}`,
    `NO_PROXY=localhost,127.0.0.1`,
  ];
  return await new Promise((done) => {
    execFile(
      "sudo",
      ["-n", "-u", machine.user, "--", "/usr/bin/env", ...carries, "/bin/bash", "-l", "-c", script],
      // A minimal environment for sudo itself: the runtime's own environment,
      // which holds the keys, must not reach the machine's shell.
      { timeout: timeoutSeconds * 1000, signal, maxBuffer: 1024 * 1024 * 16, encoding: "utf8", env: { PATH } },
      (error, stdout, stderr) => {
        const killed = Boolean((error as { killed?: boolean })?.killed);
        const code = (error as NodeJS.ErrnoException | null)?.code;
        done({
          exitCode: typeof code === "number" ? code : code === "ENOENT" ? 127 : error ? 1 : 0,
          stdout: clip(stdout ?? ""),
          stderr: clip(stderr ?? "") || (killed ? "The command was stopped: it ran out of time." : code === "ENOENT" ? "sudo: not found" : ""),
        });
      },
    );
  });
}

/**
 * shellRun: the agent runs a shell command in its machine's workspace, as the
 * machine's shell user, through the proxy chloe runs for it. Nothing the
 * command does reaches the agent's own files, its memory, or any key.
 */
export function shellRun() {
  return Object.assign(
    tool({
      description:
        "Run one shell command in your workspace and return what it printed. You run as the machine's shell user: " +
        "you own the workspace and nothing else, and you reach the internet only through the machine's proxy, so a " +
        "host not on its list fails. Name `folder` for the piece of work: it is made if missing, and every command " +
        "naming it runs there, so clones and builds stay together.",
      inputSchema: z.object({
        command: z.string().describe("The command to run, as you would type it in a shell."),
        folder: z.string().optional().describe(`A folder under ${workspaceFolder()} to run in, made if missing, like "saveyourchess". Default: the workspace.`),
        timeoutSeconds: z.number().int().min(5).max(1800).optional().describe("How long the command may run. Default: 600."),
      }),
      execute: async ({ command, folder, timeoutSeconds }, { abortSignal }) =>
        runShell(command, folder, timeoutSeconds ?? 600, abortSignal),
    }),
    {
      title: "Run shell command",
      kind: "run" as const,
      timeLimit: 30,
      // Its own output is from the machine the agent already runs in, so it
      // does not refuse the agent's next tool after one command. It is
      // refused, though, once this reply has read something from outside.
      own: true,
      afterOutside: true,
      overview: () => {
        const machine = settings.machine;
        return (
          `## Your shell\n\nYou run commands in ${workspaceFolder()} as ${machine.user}, and reach only ` +
          `these hosts: ${machine.hosts.join(", ")}. Other hosts fail, and your commands cannot read this agent's own files.`
        );
      },
    },
  );
}
