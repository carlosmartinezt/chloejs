#!/usr/bin/env node
// The server.
//
// It loads every agent, starts the clock, opens one port, and watches the tree
// so an edit is live without a restart. It names no agent: chloe.config.ts
// lists them, so adding one is adding it to that list.
//
// If this process is not running, nothing fires.
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";

import { ROOT } from "#chloe/core/paths.ts";
import { closeCutOff, trim } from "#chloe/core/db.ts";
import { loadAll, type Agent, type Running } from "#chloe/load/load.ts";
import { via } from "#chloe/model/model.ts";
import { HOST, PORT, serve } from "#chloe/serve/http.ts";
import { startClock } from "#chloe/core/clock.ts";

// Credentials a channel reads from the environment can be kept in .env beside
// the repo, which is not in source control.
if (existsSync(`${ROOT}/.env`)) process.loadEnvFile(`${ROOT}/.env`);

let agents: Map<string, Agent> = await loadAll();
trim();
const cutOff = closeCutOff();
if (cutOff) console.log(`closed ${cutOff} run${cutOff === 1 ? "" : "s"} the last stop cut off`);

const clock = startClock(() => agents);

// Every way in that is not the API: the channels each agent names. A channel
// keeps running across a reload unless a file in that agent's channels/
// folder changed, because restarting one drops whatever it was halfway
// through reading.
const running = new Map<string, Running>();

function startChannels(changed: Set<string> = new Set()): void {
  const wanted = new Set<string>();
  for (const agent of agents.values()) {
    for (const one of agent.channels) {
      const key = `${agent.name}/${one.name}`;
      wanted.add(key);
      if (running.has(key) && !changed.has(agent.name)) continue;
      running.get(key)?.stop();
      running.set(key, one.start(() => agents.get(agent.name)));
    }
  }
  for (const [key, one] of running) {
    if (!wanted.has(key)) {
      one.stop();
      running.delete(key);
    }
  }
}
startChannels();

serve({
  host: HOST,
  port: PORT,
  agents: () => agents,
  clock,
  channels: () => [...running.values()].flatMap((one) => one.routes ?? []),
});

console.log(`agents: ${[...agents.keys()].join(", ")} on http://${HOST}:${PORT}`);
console.log(`models: ${via() === "claude" ? "the claude cli, on a subscription" : "the gateway, on a key"}`);
for (const agent of agents.values()) {
  for (const job of agent.jobs) {
    console.log(
      `  ${agent.name}/${job.id}: ${job.cron ? `${job.cron} ${job.timezone}` : "when started"}` +
        (job.model ? ` on ${job.model}` : ""),
    );
  }
}

let pending: NodeJS.Timeout | undefined;
const changedChannels = new Set<string>();

function changed(path: string): void {
  for (const agent of agents.values()) {
    if (path.startsWith(`${agent.folder}/channels/`)) changedChannels.add(agent.name);
  }
  clearTimeout(pending);
  pending = setTimeout(reload, 500);
}

// One at a time. Two at once could finish in the wrong order, and the older
// read of the files would be the one that stuck.
let reloading: Promise<void> | undefined;
let again = false;

async function reload(): Promise<void> {
  if (reloading) {
    again = true;
    return;
  }
  reloading = (async () => {
    do {
      again = false;
      try {
        agents = await loadAll();
        watchFolders();
        startChannels(changedChannels);
        changedChannels.clear();
        console.log(`reloaded: ${[...agents.keys()].join(", ")}`);
      } catch (error) {
        console.error(
          "reload failed, keeping the agents that were already loaded:",
          error instanceof Error ? error.message : error,
        );
      }
    } while (again);
  })();
  await reloading;
  reloading = undefined;
}

/**
 * Reload when chloe.config.ts or anything in an agent's folder changes.
 *
 * Every folder is watched on its own, not recursively. Node's recursive watch
 * on Linux keeps a watch per file, and a file replaced rather than edited in
 * place (as git and many editors save) is never heard from again. A folder's
 * own watch sees every change inside it, however it was written.
 *
 * Debounced, because an editor saving one file fires several events, and a
 * reload halfway through someone writing a file would load a broken one. A
 * reload that throws keeps the agents that were already working, so a typo in
 * one agent does not take the others down.
 */
const watching = new Map<string, FSWatcher>();
const SKIP = new Set(["node_modules", ".git", "__pycache__"]);

function foldersIn(folder: string): string[] {
  const found = [folder];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP.has(entry.name)) found.push(...foldersIn(`${folder}/${entry.name}`));
  }
  return found;
}

function watchFolders(): void {
  const wanted = new Set([ROOT, ...[...agents.values()].flatMap((one) => foldersIn(one.folder))]);
  for (const [folder, watcher] of watching) {
    if (!wanted.has(folder)) {
      watcher.close();
      watching.delete(folder);
    }
  }
  for (const folder of wanted) {
    if (watching.has(folder)) continue;
    const top = folder === ROOT;
    const watcher = watch(folder, (_event, file) => {
      if (file && (!top || file === "chloe.config.ts")) changed(`${folder}/${file}`);
    });
    // A folder that is deleted ends its watch with an error, which would otherwise stop the service.
    watcher.on("error", () => {
      watcher.close();
      watching.delete(folder);
      changed(folder);
    });
    watching.set(folder, watcher);
  }
}
watchFolders();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clock.stop();
    process.exit(0);
  });
}
