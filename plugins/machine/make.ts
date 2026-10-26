// Making a machine for a new agent: one container, with podman or docker, from
// `machine.image`, holding the agent's files, its own copy of chloe and two
// volumes (its data, and its workspace). The copy that makes it shows it
// through `serve.elsewhere`, and starts it again when it sleeps.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import { DEFAULTS, nameInEnv, settings, type Settings } from "#chloe/core/settings";

/** podman or docker, whichever is installed (podman first), or "" for neither. */
let found: Promise<string> | undefined;
export function runner(): Promise<string> {
  found ??= (async () => {
    for (const one of ["podman", "docker"]) if ((await call(one, ["--version"]).catch(() => undefined)) !== undefined) return one;
    return "";
  })();
  return found;
}

/** Runs the program with `input` on its standard input, and hands back what it printed. Throws with what it said when it fails. */
function call(program: string, args: string[], input?: string | Readable, timeout = 120_000): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { timeout });
    let out = "";
    let said = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (said += chunk));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`${program} ${args[0]} failed: ${(said || out).trim().slice(-600)}`))));
    child.stdin.on("error", () => undefined);
    if (typeof input === "string") child.stdin.end(input);
    else if (input) input.pipe(child.stdin);
    else child.stdin.end();
  });
}

/** Why this copy cannot make a machine, in words, or "". */
export async function cannotMake(): Promise<string> {
  if (settings.machine.own) return "This copy of chloe is itself in a machine: make machines from the copy that shows it.";
  const program = await runner();
  if (!program) return "Neither podman nor docker is installed here, and one of them runs a machine.";
  if ((await call(program, ["image", "inspect", settings.machine.image]).catch(() => undefined)) === undefined) {
    const source = packageFolder();
    return `The image ${settings.machine.image} is not built here. Build the base image with: ${program} build -t chloe-machine -f ${source}/machine/Dockerfile ${source}`;
  }
  const absent = settings.machine.keys.filter((name) => !process.env[name]);
  if (absent.length) return `machine.keys names ${absent.join(", ")}, which .env does not set.`;
  return "";
}

/** The runtime's own folder, the one with machine/Dockerfile in it, found from this file in its source or its build. */
function packageFolder(): string {
  let folder = import.meta.dirname;
  while (!existsSync(join(folder, "machine", "Dockerfile")) && dirname(folder) !== folder) folder = dirname(folder);
  return folder;
}

/**
 * The machine's chloe.config.ts, and the lines of its .env. Its model settings
 * are this copy's, with `defaultModel` the one given, and each key they read is
 * handed over under the name the config reads it by, as are the names in
 * `machine.keys`.
 */
export function machineConfig(id: string, model: Settings["model"], defaultModel: string, ownerKey: string): { config: string; env: Record<string, string> } {
  const env: Record<string, string> = { CHLOE_SERVE_OWNER_KEY: ownerKey };
  const fields = [`defaultModel: ${JSON.stringify(defaultModel)}`];
  if (JSON.stringify(model.preferredRoute) !== JSON.stringify(DEFAULTS.model.preferredRoute)) fields.push(`preferredRoute: ${JSON.stringify(model.preferredRoute)}`);
  if (model.gatewayUrl !== DEFAULTS.model.gatewayUrl) fields.push(`gatewayUrl: ${JSON.stringify(model.gatewayUrl)}`);
  if (model.key) {
    const name = nameInEnv(["model", "key"]);
    env[name] = model.key;
    fields.push(`key: process.env.${name}`);
  }
  const keys = Object.entries(model.keys).filter(([, value]) => value);
  if (keys.length) {
    for (const [provider, value] of keys) env[nameInEnv(["model", "keys", provider])] = value;
    fields.push(`keys: { ${keys.map(([provider]) => `${provider}: process.env.${nameInEnv(["model", "keys", provider])}`).join(", ")} }`);
  }
  for (const name of settings.machine.keys) if (process.env[name]) env[name] = process.env[name]!;
  const config = `// ${id}'s machine: one agent, in a machine of its own. Written by the copy of
// chloe that made it, which shows it on its page through serve.elsewhere and
// starts it again when it has stopped.
import { defineConfig } from "@chloejs/core";

import agent from "./workspace/routines/agent.ts";

export default defineConfig({
  agents: [agent],
  settings: {
    machine: { own: true },
    model: { ${fields.join(", ")} },
    serve: { host: "0.0.0.0", port: 3067, ownerKey: process.env.CHLOE_SERVE_OWNER_KEY, stopAfter: ${STOP_AFTER} },
  },
});
`;
  return { config, env };
}

/** The idle minutes before a machine stops itself, until it is wanted again. */
const STOP_AFTER = 15;

/**
 * The command that starts the machine. Under systemd it runs in a scope of
 * its own, or restarting this copy's service would kill the container's
 * monitor with it.
 */
export function startCommand(program: string, name: string, underSystemd = Boolean(process.env.INVOCATION_ID)): string[] {
  return underSystemd ? ["systemd-run", "--user", "--scope", "--quiet", program, "start", name] : [program, "start", name];
}

/** A port on this computer's loopback for the machine: the first from this copy's own port plus 100 that nothing has, here or in a container. */
async function freePort(program: string): Promise<number> {
  const used = new Set<number>();
  for (const one of Object.values(settings.serve.elsewhere)) {
    const port = Number(URL.canParse(one.address) ? new URL(one.address).port : 0);
    if (port) used.add(port);
  }
  const published = await call(program, ["ps", "--all", "--format", "{{.Ports}}"]).catch(() => "");
  for (const one of published.matchAll(/:(\d+)->/g)) used.add(Number(one[1]));
  const first = settings.serve.port + 100;
  for (let port = first; port < first + 200; port++) if (!used.has(port) && (await free(port))) return port;
  throw new Error(`No free port from ${first} to ${first + 199} for the machine.`);
}

function free(port: number): Promise<boolean> {
  return new Promise((done) => {
    const holder = createServer();
    holder.once("error", () => done(false));
    holder.listen(port, "127.0.0.1", () => holder.close(() => done(true)));
  });
}

/** How long a new machine has to answer, after it is started with its keys. */
const ANSWER_WITHIN = 90_000;

/**
 * Makes the machine for a new agent and starts it: a container named
 * `chloe-<id>`, its volumes `chloe-<id>-data` and `chloe-<id>-work`, the
 * agent's files in its workspace as a git repository, its config, and its keys
 * in its .env. Answers once the machine lists the agent. Removes all of it when
 * any step fails.
 */
export async function makeMachine(agent: { id: string; files: Record<string, string>; model: string }): Promise<{ address: string; key: string; start: string[] }> {
  const program = await runner();
  const image = settings.machine.image;
  const name = `chloe-${agent.id}`;
  const [data, work] = [`${name}-data`, `${name}-work`];
  if ((await call(program, ["inspect", "--type", "container", name]).catch(() => undefined)) !== undefined) {
    throw new Error(`A container called ${name} is already on this computer.`);
  }
  const port = await freePort(program);
  const key = randomBytes(32).toString("hex");
  const { config, env } = machineConfig(agent.id, settings.model, agent.model, key);
  const start = startCommand(program, name);
  const address = `http://127.0.0.1:${port}`;
  const folder = await mkdtemp(join(tmpdir(), "chloe-machine-"));
  try {
    for (const volume of [data, work]) await call(program, ["volume", "create", volume]);
    await call(program, [
      "create", "--name", name, "--label", `chloe.agent=${agent.id}`,
      "--cap-add=NET_ADMIN", "--cap-add=SYS_ADMIN",
      "--publish", `127.0.0.1:${port}:3067`,
      "--volume", `${data}:/home/runtime/data`,
      "--volume", `${work}:/home/runtime/workspace`,
      image,
    ]);

    await writeFile(join(folder, "chloe.config.ts"), config, { mode: 0o644 });
    await call(program, ["cp", join(folder, "chloe.config.ts"), `${name}:/home/runtime/chloe.config.ts`]);

    // The agent's files, committed as its first change, into the workspace volume.
    const files = join(folder, "routines");
    for (const [path, body] of Object.entries(agent.files)) {
      await mkdir(dirname(join(files, path)), { recursive: true });
      await writeFile(join(files, path), body);
    }
    const tar = spawn("tar", ["-C", files, "-cf", "-", "."]);
    await call(program, [
      "run", "--rm", "-i", "--user", "root", "--entrypoint", "sh", "--volume", `${work}:/work`, image, "-c",
      `mkdir -p /work/routines && cd /work/routines && tar --no-same-owner -xf - &&
       git init -q && git add -A &&
       GIT_AUTHOR_NAME=${agent.id} GIT_AUTHOR_EMAIL= GIT_COMMITTER_NAME=${agent.id} GIT_COMMITTER_EMAIL= git -c commit.gpgsign=false commit -qm "${agent.id}, made" &&
       chown -R runtime:runtime /work/routines`,
    ], tar.stdout);

    // .env is the runtime user's alone, so it is written by that user, which
    // needs the machine running; the keys are read as chloe starts, so it
    // starts again after.
    await call(start[0], start.slice(1));
    const lines = Object.entries(env).map(([one, value]) => `${one}=${value}`).join("\n") + "\n";
    await call(program, ["exec", "-i", "-u", "runtime", name, "sh", "-c", "umask 077 && cat > /home/runtime/.env"], lines);
    await call(program, ["exec", "-u", "root", name, "chown", "runtime:runtime", "/home/runtime/chloe.config.ts"]);
    await call(program, ["stop", "-t", "10", name]);
    await call(start[0], start.slice(1));

    const until = Date.now() + ANSWER_WITHIN;
    for (;;) {
      const listed = await fetch(`${address}/api/agents`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3_000) })
        .then(async (answer) => (answer.ok ? ((await answer.json()) as { id: string }[]) : []))
        .catch(() => []);
      if (listed.some((one) => one.id === agent.id)) break;
      if (Date.now() > until) {
        const log = await call(program, ["logs", "--tail", "15", name]).catch(() => "");
        throw new Error(`The machine did not list ${agent.id} within ${ANSWER_WITHIN / 1000} seconds. Its log ends:\n${log.trim()}`);
      }
      await new Promise((done) => setTimeout(done, 1_000));
    }
    return { address, key, start };
  } catch (error) {
    await call(program, ["rm", "--force", name]).catch(() => undefined);
    for (const volume of [data, work]) await call(program, ["volume", "rm", "--force", volume]).catch(() => undefined);
    throw error;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
