// The server.
//
// It loads every agent, starts the clock, opens one port, and watches the tree
// so an edit is live without a restart. It names no agent: chloe.config.ts
// lists them, so adding one is adding it to that list. A script with no
// chloe.config.ts hands its agents and settings to `startChloe` instead.
//
// If this process is not running, nothing fires.
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import { loadEnv } from "#chloe/core/env";
import { ROOT } from "#chloe/core/paths";
import { bold, dim } from "#chloe/core/style";
import { PROVIDERS, settings, unclaimed } from "#chloe/core/settings";
import { closeCutOff, going, trim } from "#chloe/core/db";
import { checksDone, CONFIG, loadAll, type Agent, type Config, type Running } from "#chloe/load/load";
import { sdkModel } from "#chloe/model/key";
import { neededBy } from "#chloe/model/tool";
import { run } from "#chloe/services/runService";
import { learnModels, runnable } from "#chloe/model/model";
import { certificate } from "#chloe/serve/certificate";
import { claimPort, ownAddress, remoteAddress, serve as listen } from "#chloe/serve/http";
import { startClock } from "#chloe/core/clock";
import { hasPassword, makeLink } from "#chloe/serve/login";
import { alertsSay } from "#chloe/core/alerts";

/**
 * Starts chloe in this process: every agent's cron lines and channels, and
 * chloe's web server. The promise resolves once everything has started, and
 * chloe keeps running until the process stops. To run one job and exit, use `agent.run`.
 *
 * `npx chloe` calls it with no options, and it reads `chloe.config.ts`. A
 * script with no `chloe.config.ts` can pass the agents and settings that file
 * would hold, so one file can be a whole project:
 *
 * ```ts
 * await startChloe({ agents: [inbox], settings: { agents: { inbox: { telegram: process.env.TELEGRAM_TOKEN } } } });
 * ```
 *
 * If you pass them and there is a `chloe.config.ts`, it throws an error. After
 * you edit that script or its `.env`, restart it: `node --watch` does that for
 * you.
 *
 * `remote: true` is `npx chloe --remote`, for a server reached over SSH: it
 * listens on every address and serves the page over HTTPS, with a certificate
 * it makes and keeps in the state folder, so the browser warns once. Plain
 * HTTP still answers on loopback, for the commands that talk to it.
 */
export async function startChloe(given?: Config, options: { remote?: boolean } = {}): Promise<void> {
  if (given && existsSync(CONFIG)) {
    throw new Error(`startChloe was given agents and settings, but ${CONFIG} holds this project's. Put them there, or run it from a folder without one.`);
  }

  let agents: Map<string, Agent> = await loadAll(given);
  // First, while nothing has started: a copy that cannot have the port is a
  // second one, and must not touch the first one's runs on its way out.
  const heldPort = await claimPort(options.remote ? "0.0.0.0" : settings.serve.host, settings.serve.port);
  const remote = options.remote ? certificate() : undefined;
  // What each route can run, and what a call on a provider's own key costs.
  // Not waited for: until it answers, such a call is recorded at no cost.
  void learnModels();

  // The last resort: a throw nobody held must not take down every job and
  // every run in flight. Say it and keep going; whatever caused it is still
  // broken, but the box stays up until the next reload or restart.
  process.on("unhandledRejection", (reason) => console.error("unhandled rejection:", reason));
  process.on("uncaughtException", (error) => console.error("uncaught exception:", error));

  /** An entry under `agents` in settings that no agent claims is usually one that was renamed. */
  function sayUnclaimed(): void {
    for (const name of unclaimed([...agents.keys()])) {
      console.error(`settings: "agents" has an entry for ${name}, and no agent is called that. If it was renamed, rename the entry too.`);
    }
  }
  sayUnclaimed();
  trim();
  const cutOff = closeCutOff();
  if (cutOff) console.log(`closed ${cutOff} run${cutOff === 1 ? "" : "s"} the last stop cut off`);

  const clock = startClock(() => agents);

  // Every way in that is not the API: the channels each agent names. A channel
  // keeps running across a reload unless the options it was made with changed,
  // wherever they are written, or the settings did, because restarting one drops
  // whatever it was halfway through reading.
  const running = new Map<string, Running & { madeWith?: string }>();

  function startChannels(changed: Set<string> = new Set()): void {
    const wanted = new Set<string>();
    for (const agent of agents.values()) {
      for (const one of agent.channels) {
        const key = `${agent.id}/${one.name}`;
        wanted.add(key);
        const now = running.get(key);
        if (now && !changed.has(agent.id) && now.madeWith === one.madeWith) continue;
        if (now) console.log(`${key}: restarted, ${changed.has(agent.id) ? "the settings" : "its options"} changed`);
        now?.stop();
        running.set(key, { ...one.start(() => agents.get(agent.id)), madeWith: one.madeWith });
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

  const server = listen({
    host: settings.serve.host,
    port: settings.serve.port,
    agents: () => agents,
    clock,
    channels: () => [...running.values()].flatMap((one) => one.routes ?? []),
    heldPort,
    certificate: remote,
  });

  const outside = await connected();
  for (const line of startup(outside)) console.log(line);

  /**
   * Each connection the agents' tools need, with what it is missing, and git when
   * a memory is committed and there is none. Asked once, as it starts.
   */
  async function connected(): Promise<{ names: string[]; missing: string[] }> {
    const all = [...agents.values()];
    const used = [...new Set(all.flatMap((agent) => [...neededBy(agent), ...(agent.connections ?? [])]))];
    const missing = (
      await Promise.all(
        used.map(async (one) =>
          (await one.missing().catch((error: Error) => [error.message])).map((line) => `${one.name}: ${line}`),
        ),
      )
    ).flat();
    if (all.some((agent) => agent.memory.commit) && (await run("git", ["--version"])).exitCode !== 0) {
      missing.push("git: not installed, so no memory is committed. Install git.");
    }
    return { names: used.map((one) => one.name), missing };
  }

  /** One row of the block at startup: a label, and what there is to say about it. */
  function row(label: string, said: string): string {
    return `  ${bold(label.padEnd(12))}${said}`;
  }

  /** A line under a row, lined up with what the row said. */
  function under(said: string): string {
    return `  ${"".padEnd(12)}${dim(said)}`;
  }

  /** What the model route is called in words rather than in settings. */
  function byRoute(route: string): string {
    if (route === "gateway") return "the AI gateway, on a key";
    if (route === "direct") {
      const held = PROVIDERS.filter((one) => settings.model.keys[one]);
      return held.length > 1 ? `the ${held.join(" and ")} APIs, each on its own key` : `the ${held[0]} API, on its own key`;
    }
    if (route === "claude") return "Claude, on a subscription";
    if (route === "codex") return "Codex, on a ChatGPT plan";
    return "opencode, on whatever it is signed in to";
  }

  /**
   * Everything worth knowing as it starts: where it is, how to get in, what it
   * asks when a step needs a model, and what runs on a clock. Each line that
   * reports something missing carries the command that fixes it, because a person
   * reading this is usually about to go looking for one.
   */
  function startup(outside: { names: string[]; missing: string[] }): string[] {
    const lines = ["", bold("Chloe is running."), ""];

    lines.push(row("Agents", [...agents.keys()].join(", ") || dim("none yet. Write one in agents/, and list it in chloe.config.ts")));

    // With no password, the link is the way in, so it is printed where whoever
    // started this will look for it.
    const address = remote ? remoteAddress() : ownAddress();
    if (hasPassword()) {
      lines.push(row("Page", address));
      lines.push(under("Sign in with the password, or a link from npx chloe link. Forgot it? npx chloe account"));
    } else {
      lines.push(row("Page", makeLink(address)));
      lines.push(under("Opens the page signed in, in one browser, within the hour. Another: npx chloe link"));
    }
    if (remote) {
      lines.push(under("The browser will say the connection is not private, because the certificate is this chloe's own."));
      lines.push(under(`Go on past it. Its fingerprint is ${remote.fingerprint}`));
      lines.push(under(`If the page does not open, a firewall is closing port ${settings.serve.port}.`));
    } else if (process.env.SSH_CONNECTION) {
      lines.push(under("You are on this machine over SSH, so the link opens only here. To open the page on your own"));
      lines.push(under(`computer, start chloe with: npx chloe --remote`));
    }
    lines.push(row("Alerts", alertsSay()));

    // Every route in the order they are tried, those this box is set up for only,
    // so the line says what will actually be used and not what was asked for.
    const ready = settings.model.preferredRoute.filter((one) => runnable(one));
    // An AI SDK model goes by its own package, whatever preferredRoute says.
    const given = [...new Set([...agents.values()].flatMap((agent) => [agent.model, ...agent.jobs.flatMap((job) => (job.model ? [job.model] : []))]))].filter((one) => sdkModel(one));
    const reached = [...ready.map(byRoute), ...(given.length ? [`${given.join(", ")} by the AI SDK`] : [])];
    lines.push(row("AI models", reached.length ? reached.join("; ") : "not set up"));
    if (ready[0] === "claude" || ready[0] === "codex") {
      lines.push(under(
        "A subscription is fine while you build and try agents. Its terms may not cover agents running on their own, " +
          'so for that put "direct" or "gateway" first in model.preferredRoute, with a key.',
      ));
    }
    if (!ready.length && !given.length) {
      lines.push(under(
        `Nothing in model.preferredRoute is set up here (${settings.model.preferredRoute.join(", ")}). Set one up: npx chloe setup`,
      ));
    }

    const jobs = [...agents.values()].flatMap((agent) =>
      agent.jobs.map(
        (job) =>
          `${agent.id}/${job.id}  ${job.cron ? `${job.cron} ${job.timezone}` : "when started"}` + (job.model ? ` on ${job.model}` : ""),
      ),
    );
    lines.push(row("Jobs", jobs.length ? jobs[0] : dim("none yet")));
    for (const job of jobs.slice(1)) lines.push(under(job));

    if (outside.names.length || outside.missing.length) {
      lines.push(row("Connections", outside.names.join(", ") || dim("none")));
      for (const line of outside.missing) lines.push(under(line));
    }

    // Node reads an agent file as CommonJS first when the project does not say,
    // which works until the day a file happens to parse both ways.
    let type = "";
    try {
      type = (JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { type?: string }).type ?? "";
    } catch {
      // No package.json is a project that has not run npm install. It has bigger problems.
    }
    if (type !== "module") {
      lines.push(row("package.json", 'add "type": "module", so node reads your agent files as modules'));
    }

    lines.push("", dim("  Need help? Run: npx chloe help"), "");
    return lines;
  }

  let pending: NodeJS.Timeout | undefined;
  const changedChannels = new Set<string>();
  // A change to either means every setting is read again, and a channel reads its
  // token as it starts, so the channels go round with them. A script's settings
  // were read as it started, so for one of those it takes a restart.
  const SETTINGS = given ? [] : [".env", "chloe.config.ts"];
  let settingsChanged = false;

  function changed(path: string): void {
    if (SETTINGS.some((file) => path === `${ROOT}/${file}`)) settingsChanged = true;
    clearTimeout(pending);
    pending = setTimeout(reload, 500);
  }

  // One at a time. Two at once could finish in the wrong order, and the older
  // read of the files would be the one that stuck.
  let reloading: Promise<void> | undefined;
  let again = false;

  async function reload(): Promise<void> {
    if (stopping) return;
    if (reloading) {
      again = true;
      return;
    }
    reloading = (async () => {
      do {
        again = false;
        try {
          // .env first, so loadAll reads the config with the new environment over
          // it. loadAll is what declares the settings, so nothing reloads them here.
          if (settingsChanged) {
            settingsChanged = false;
            loadEnv();
            for (const name of agents.keys()) changedChannels.add(name);
          }
          // A self write being checked may put a file back: read what it leaves.
          await checksDone();
          agents = await loadAll(given);
          // A stop that came while the files were read must not start the channels again.
          if (stopping) return;
          // What each route can run, for the list somebody picks from. Asked here
          // and never from a request, so a slow gateway cannot hold up a page.
          await learnModels();
          sayUnclaimed();
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
   * Reload when chloe.config.ts, .env, anything in an agent's folder, or a file
   * one of its prompts includes, changes.
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
   *
   * An agent's memory is left out even when it is inside the agent's folder:
   * it changes on every run and is never loaded.
   */
  const watching = new Map<string, FSWatcher>();
  /** Each watched folder, and the names in it that matter, read afresh by its watcher on every change. */
  let wanted = new Map<string, Set<string> | "all">();
  const SKIP = new Set(["node_modules", ".git", "__pycache__"]);

  function foldersIn(folder: string, memory: string): string[] {
    if (folder === memory) return [];
    const found = [folder];
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP.has(entry.name)) found.push(...foldersIn(`${folder}/${entry.name}`, memory));
    }
    return found;
  }

  function watchFolders(): void {
    // Each folder, and the names in it that matter: every one in an agent's own
    // folder, and only the named ones beside the config and beside a file a
    // prompt includes.
    wanted = new Map<string, Set<string> | "all">([[ROOT, new Set(SETTINGS)]]);
    for (const agent of agents.values()) {
      for (const folder of foldersIn(agent.folder, agent.memory.folder)) wanted.set(folder, "all");
      for (const file of agent.included ?? []) {
        const names = wanted.get(dirname(file));
        if (names === "all") continue;
        wanted.set(dirname(file), new Set([...(names ?? []), basename(file)]));
      }
    }
    // An agent kept in the project's own folder still reloads only for the settings there.
    if (wanted.get(ROOT) === "all") wanted.set(ROOT, new Set(SETTINGS));
    for (const [folder, watcher] of watching) {
      if (!wanted.has(folder)) {
        watcher.close();
        watching.delete(folder);
      }
    }
    for (const folder of wanted.keys()) {
      if (watching.has(folder) || !existsSync(folder)) continue;
      const watcher = watch(folder, (_event, file) => {
        const names = wanted.get(folder);
        if (file && (names === "all" || names?.has(file))) changed(`${folder}/${file}`);
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

  /**
   * Stop the clock and the port, let the runs that are going
   * finish, then exit. A run still going after STOP_WAIT is left as it is, and
   * the next start closes it as cut off. A second signal exits at once, for a
   * person at a terminal who meant it.
   */
  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) process.exit(0);
    stopping = true;
    clearTimeout(pending);
    for (const watcher of watching.values()) watcher.close();
    clock.stop();
    server.close();
    const until = Date.now() + STOP_WAIT;
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
    let left = going();
    const waited = left > 0;
    if (left) console.log(`stopping: waiting up to ${STOP_WAIT / 1000} seconds for ${left} run${left === 1 ? "" : "s"} to finish. Stop again to stop now.`);
    while (left && Date.now() < until) {
      await wait(250);
      left = going();
    }
    if (left) console.log(`stopping: ${left} still going, closed as cut off at the next start`);
    // The channels go last, and not at once: a run is marked finished just
    // before its answer is sent, and a channel's calls end when it stops.
    if (waited) await wait(2000);
    for (const one of running.values()) one.stop();
    process.exit(0);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());
}

/**
 * How long a stop waits for the runs that are going. Long enough for a model
 * step, and inside the 90 seconds systemd gives a service before it kills it.
 * The units `npx chloe install` writes give it 75.
 */
const STOP_WAIT = 60_000;

