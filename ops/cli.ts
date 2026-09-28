#!/usr/bin/env node
// `npx chloe`: the one command, for a project that installed chloe rather than
// cloned it. Every word below is a file in this folder that reads process.argv
// itself, so the word is taken off the front and the file is imported. Each
// runs the same way from this repo's own npm scripts.
import { existsSync } from "node:fs";

const WHAT = `chloe: agents that are mostly code.

  npx chloe                      the server: every agent, every cron line, one port
  npx chloe account              set the one password, or a new one later
  npx chloe agent <name>         talk to one agent in this terminal
  npx chloe agent <name> "..."   ask it one thing and stop
  npx chloe agent <name> <job>   run one of its jobs now, step by step
  npx chloe evals <agent>        score that agent's prompts
  npx chloe install              install chloe.service, so it survives a reboot

Run it from the folder with chloe.config.ts in it.
`;

const word = process.argv[2];

if (word === "help" || word === "--help" || word === "-h") {
  process.stdout.write(WHAT);
  process.exit(0);
}

if (word && !["account", "agent", "evals", "install"].includes(word)) {
  process.stderr.write(`chloe: there is no "${word}".\n\n${WHAT}`);
  process.exit(1);
}

// core/root walks up for chloe.config.ts and throws if there is none. Asked
// here so that from a terminal the usual mistake is a line and not a stack,
// and asked rather than repeated so the two cannot disagree about where to look.
try {
  await import("#chloe/core/root");
} catch (error) {
  process.stderr.write(`chloe: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (!word) {
  // The server is what `npx chloe` on its own means, and it takes no arguments.
  await import("#chloe/server");
} else if (word === "install") {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  // install.sh is a shell script, so it is not compiled: it sits beside this
  // file in the source and two folders up from the built dist/ops/cli.js.
  const beside = fileURLToPath(new URL("./install.sh", import.meta.url));
  const script = existsSync(beside) ? beside : fileURLToPath(new URL("../../ops/install.sh", import.meta.url));
  process.exit(spawnSync("bash", [script], { stdio: "inherit" }).status ?? 1);
} else {
  process.argv.splice(2, 1);
  await import(`#chloe/ops/${word}`);
}
