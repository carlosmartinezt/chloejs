#!/usr/bin/env node
// `npx chloe`: the one command, for a project that installed chloe rather than
// cloned it. Every word below is a file in this folder that reads process.argv
// itself, so the word is taken off the front and the file is imported. Each
// runs the same way from this repo's own npm scripts.
import { existsSync } from "node:fs";

import { bold, dim } from "#chloe/core/style";

const WHAT = `${bold("Chloe is a TypeScript agent framework that uses AI only when you need it.")}
See https://chloejs.org.

${bold("Starting out")}
  npx chloe setup                write the files, pick a model, set the password
  npx chloe                      run it: every agent, every cron line, one page

${bold("Every day")}${dim("  (these talk to a running chloe, so leave npx chloe going)")}
  npx chloe agent                pick an agent and talk to it
  npx chloe agent <id>           talk to that one
  npx chloe agent <id> "..."     ask it one thing and stop
  npx chloe agent <id> <job>     run one of its jobs now, step by step
  npx chloe evals <id>           score that agent's prompts

${bold("Looking after it")}
  npx chloe account              set the password for the page, or a new one later
  npx chloe install              keep it running after a reboot (Linux or macOS)

Run it from the folder with chloe.config.ts in it, which setup writes.
`;

const WORDS = ["setup", "account", "agent", "evals", "install"];

const word = process.argv[2];

if (word === "help" || word === "--help" || word === "-h") {
  process.stdout.write(WHAT);
  process.exit(0);
}

if (word && !WORDS.includes(word)) {
  process.stderr.write(`chloe: there is no "${word}".\n\n${WHAT}`);
  process.exit(1);
}

// Whether there is a chloe.config.ts here at all. Setup is the one word that
// runs without one, because writing one is what it does.
const { findConfig, NO_CONFIG } = await import("#chloe/core/find");

if (!findConfig()) {
  if (word !== "setup") {
    process.stderr.write(`chloe: no chloe.config.ts at or above ${process.cwd()}. ${NO_CONFIG}\n`);
    const { yes } = await import("./terminal.ts");
    if (!process.stdin.isTTY || !(await yes("\nSet this folder up now? (Y/n)", true))) {
      process.stderr.write('Setting up is "npx chloe setup".\n');
      process.exit(1);
    }
  }
  await import("#chloe/ops/setup");
  process.exit(0);
}

if (word === "setup") {
  await import("#chloe/ops/setup");
} else if (!word) {
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
