// Making an agent's machine from its definition, and keeping it in step: an
// agent whose agent.ts says `workspace: { sandbox: { ... } }` runs in one
// container, with podman or docker, made from its image, holding its own copy
// of chloe and its volumes, with the agent's folder lent to it. This copy
// shows it on its page and starts it again when it has stopped.
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { STATE } from "#chloe/core/paths";
import { declaredSettings, KEYS, nameInEnv, settings } from "#chloe/core/settings";
import type { DefinedAgent } from "#chloe/load/load";
import type { MachineAddress } from "#chloe/load/plugin";
import { isRepoTop } from "#chloe/services/historyService";

/** Where the agent works, under `workspace` in its agent.ts. */
export interface Workspace {
  /**
   * The machine of its own the agent runs in. With it, this copy does not
   * run the agent: it makes the machine, keeps it as this says, and shows the
   * agent on its page. Without it, the agent runs here. See docs/machines.md.
   */
  sandbox?: Sandbox;
  /**
   * Where the agent's work is kept in its machine (its clones, the folders
   * its shell makes): a volume of the machine's own, or a folder of this
   * computer. Default: `{ type: "volume" }`, the volume `chloe-<id>-work`.
   */
  filesystem?: { type: "volume" } | { type: "local"; path: string };
}

/** A machine of the agent's own, under `workspace.sandbox` in its agent.ts. */
export interface Sandbox {
  /** The program that runs the machine. Required. */
  type: "podman" | "docker";
  /**
   * The machine's image: a Dockerfile, as a path from the agent's folder like
   * "./machine/Dockerfile", which starts `FROM chloe-machine` and adds the
   * programs the agent needs, or the name of an image already built. A
   * Dockerfile is built again when it or the base image changes. Default:
   * `machine.image`.
   */
  image?: string;
  /**
   * Files and folders of this computer the machine sees, at the same path,
   * each `"read"` or `"write"`: `{ "/srv/site/data": "write" }`. Anything
   * lent for writing makes the machine's own user this computer's user, so
   * it can write there. Default: none.
   */
  lend?: Record<string, "read" | "write">;
  /** Plain values for the machine's environment, like where a lent file is. A secret goes in `keys`. Default: none. */
  env?: Record<string, string>;
  /**
   * Names in this copy's .env the machine is also given, under the same name,
   * like a token only this agent uses. `machine.keys` in settings names those
   * every machine gets. Default: none.
   */
  keys?: string[];
  /**
   * A script in the agent's folder, run in the machine as chloe's user, with
   * the machine's environment, each time the machine is made: a clone, a
   * package install, a git setting. The machine starts again after it.
   * Default: none.
   */
  setup?: string;
}

/** podman or docker, whichever is installed (podman first), or "" for neither. */
let found: Promise<string> | undefined;
export function runner(): Promise<string> {
  found ??= (async () => {
    for (const one of ["podman", "docker"]) if (await installed(one)) return one;
    return "";
  })();
  return found;
}

const programs = new Map<string, Promise<boolean>>();
function installed(program: string): Promise<boolean> {
  if (!programs.has(program)) programs.set(program, call(program, ["--version"]).then(() => true, () => false));
  return programs.get(program)!;
}

/** Runs the program with `input` on its standard input, and hands back what it printed. Throws with what it said when it fails. */
function call(program: string, args: string[], input?: string, timeout = 120_000): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { timeout });
    let out = "";
    let said = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (said += chunk));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`${program} ${args[0]} failed: ${(said || out).trim().slice(-600)}`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

/** Why this copy cannot make a machine, in words, or "". */
export async function cannotMake(): Promise<string> {
  if (settings.machine.own) return "This copy of chloe is itself in a machine: make machines from the copy that shows it.";
  if (!(await runner())) return "Neither podman nor docker is installed here, and one of them runs a machine.";
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

/** An image's id, or "" when it is not built. */
function imageId(program: string, image: string): Promise<string> {
  return call(program, ["image", "inspect", "--format", "{{.Id}}", image]).then((out) => out.trim(), () => "");
}

/**
 * Which runtime this copy is: the package's version, and the commit when it
 * runs from a clone. The base image is labelled with the one it was built
 * from, so a new release or a new commit builds it again; an edit not yet
 * committed does not.
 */
async function runtimeOf(source: string): Promise<string> {
  const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { version: string };
  const commit = (await isRepoTop(source)) ? (await call("git", ["-C", source, "rev-parse", "HEAD"]).catch(() => "")).trim() : "";
  return commit ? `${version}-${commit.slice(0, 12)}` : version;
}

/** Base images built over, removed once no agent's image is built on them. */
const replaced = new Set<string>();

/** The base image being built now, so machines made at once wait for one build. */
let building: Promise<string> | undefined;

/**
 * The base image, `machine.image`. When it is the default, it is built from
 * this package's machine/Dockerfile when it is missing or was built from
 * another runtime than this copy's, so every machine runs the runtime this
 * copy does. One of the owner's own is used as it is.
 */
function baseImage(program: string): Promise<string> {
  building ??= (async () => {
    const base = settings.machine.image;
    if (base !== "chloe-machine") {
      const id = await imageId(program, base);
      if (!id) throw new Error(`The image ${base} (machine.image) is not built here.`);
      return id;
    }
    const source = packageFolder();
    const runtime = await runtimeOf(source);
    const built = await call(program, ["image", "inspect", "--format", '{{index .Labels "chloe.runtime"}}', base]).then((out) => out.trim(), () => undefined);
    if (built !== runtime) {
      const before = await imageId(program, base);
      console.log(`machines: building the base image chloe-machine from ${source}, runtime ${runtime}${built !== undefined ? `, in place of ${built || "an unknown one"}` : ""}`);
      await call(program, ["build", "--quiet", "--label", `chloe.runtime=${runtime}`, "-t", base, "-f", join(source, "machine", "Dockerfile"), source], undefined, 30 * 60_000);
      if (before) replaced.add(before);
    }
    return imageId(program, base);
  })().finally(() => (building = undefined));
  return building;
}

/** Whether the sandbox's image is a Dockerfile in the agent's folder, rather than an image's name. */
function isFile(image: string): boolean {
  return image.startsWith(".") || isAbsolute(image) || /Dockerfile$/.test(image);
}

/**
 * The image the agent's machine runs: the one its sandbox names, or its
 * Dockerfile built as `chloe-<id>:<a hash of the file and the base image>`,
 * so a change to either builds it again and nothing else does.
 */
async function imageFor(agent: DefinedAgent, sandbox: Sandbox): Promise<string> {
  const program = sandbox.type;
  const base = await baseImage(program);
  const said = sandbox.image ?? settings.machine.image;
  if (!isFile(said)) {
    if (!(await imageId(program, said))) throw new Error(`The image ${said} is not built here.`);
    return said;
  }
  const file = resolve(agent.folder, said);
  if (!existsSync(file)) throw new Error(`${agent.id}'s sandbox names the image ${said}, and there is no such file in its folder.`);
  const tag = `chloe-${agent.id}:${createHash("sha256").update(await readFile(file)).update(base).digest("hex").slice(0, 12)}`;
  if (await imageId(program, tag)) return tag;
  console.log(`${agent.id}: building its machine's image from ${said}`);
  await call(program, ["build", "--quiet", "-t", tag, "-f", file, dirname(file)], undefined, 60 * 60_000);
  return tag;
}

/** The images built for the agent before `kept`, removed once its machine runs on `kept`. One still in use stays. */
async function forgetOldImages(program: string, id: string, kept: string): Promise<void> {
  const listed = await call(program, ["images", "--format", "{{.Repository}}:{{.Tag}}", `chloe-${id}`]).catch(() => "");
  for (const one of listed.split("\n").map((line) => line.trim().replace(/^localhost\//, ""))) {
    if (one && one !== kept && one.startsWith(`chloe-${id}:`)) await call(program, ["rmi", one]).catch(() => undefined);
  }
  for (const old of replaced) if (await call(program, ["rmi", old]).then(() => true, () => false)) replaced.delete(old);
}

/** The key the agent's machine takes as its owner: made once, and kept in this copy's state folder, readable by this user only. */
async function keyFor(id: string): Promise<string> {
  const folder = join(STATE, "machines");
  const file = join(folder, `${id}.key`);
  if (existsSync(file)) return (await readFile(file, "utf8")).trim();
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  return key;
}

const isGroup = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isSecret = (path: string[]) => KEYS.some((key) => path.join(".") === key || path.join(".").startsWith(`${key}.`));

/** A setting's value as code for the machine's config: a secret as `process.env.<name>`, put in `env` under that name. */
function written(value: unknown, path: string[], env: Record<string, string>): string {
  if (isSecret(path) && typeof value === "string" && value) {
    const name = nameInEnv(path);
    env[name] = value;
    return `process.env.${name}`;
  }
  if (isGroup(value)) {
    const fields = Object.entries(value).filter(([, one]) => one !== undefined);
    return `{ ${fields.map(([key, one]) => `${/^[a-z_$][\w$]*$/i.test(key) ? key : JSON.stringify(key)}: ${written(one, [...path, key], env)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/**
 * The machine's chloe.config.ts, and the lines of its .env. Its settings are
 * this copy's, as its config says them, all but `serve` and `machine`, and of
 * `agents` only this agent's own; each secret among them is handed over under
 * the name it would have in .env. `ownerKey` is what the machine takes as its
 * owner, from this copy.
 */
export function machineConfig(id: string, ownerKey: string): { config: string; env: Record<string, string> } {
  const env: Record<string, string> = { CHLOE_SERVE_OWNER_KEY: ownerKey };
  const said = declaredSettings() as Record<string, unknown>;
  const parts: string[] = [];
  for (const [name, value] of Object.entries(said)) {
    if (name === "serve" || name === "machine" || value === undefined) continue;
    const kept = name === "agents" ? (isGroup(value) && value[id] ? { [id]: value[id] } : undefined) : value;
    if (kept !== undefined) parts.push(`${name}: ${written(kept, [name], env)}`);
  }
  const hosts = isGroup(said.machine) && said.machine.hosts ? `, hosts: ${JSON.stringify(said.machine.hosts)}` : "";
  parts.push(`machine: { own: true${hosts} }`);
  parts.push(`serve: { host: "0.0.0.0", port: 3067, ownerKey: process.env.CHLOE_SERVE_OWNER_KEY }`);
  const config = `// ${id}'s machine: one agent, in a machine of its own. Written by the copy of
// chloe that made it, from that copy's settings, each time it makes it.
import { defineConfig } from "@chloejs/core";

import agent from "./workspace/routines/agent.ts";

export default defineConfig({
  agents: [agent],
  settings: {
    ${parts.join(",\n    ")},
  },
});
`;
  return { config, env };
}

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

/** The machine as it is now: what it was made from, whether it is running, and its port on this computer. */
async function inspect(program: string, name: string): Promise<{ made: string; running: boolean; port: number } | undefined> {
  const out = await call(program, ["inspect", "--type", "container", "--format", '{{index .Config.Labels "chloe.made"}} {{.State.Running}}', name]).catch(() => undefined);
  if (out === undefined) return undefined;
  const [made, running] = out.trim().split(" ");
  const bound = await call(program, ["inspect", "--type", "container", "--format", "{{json .HostConfig.PortBindings}}", name]).catch(() => "");
  const port = Number(bound.match(/"HostPort":"(\d+)"/)?.[1] ?? 0);
  return { made, running: running === "true", port };
}

/** How long a machine has to list its agent once it is started. */
const ANSWER_WITHIN = 90_000;

/** Waits until the machine lists the agent. Throws with the end of its log when it does not in time. */
async function listed(program: string, name: string, address: string, key: string, id: string): Promise<void> {
  const until = Date.now() + ANSWER_WITHIN;
  for (;;) {
    const agents = await fetch(`${address}/api/agents`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3_000) })
      .then(async (answer) => (answer.ok ? ((await answer.json()) as { id: string; address?: string }[]) : []))
      .catch(() => []);
    // Its own, loaded there, and not one it says it would show from somewhere else.
    if (agents.some((one) => one.id === id && one.address === undefined)) return;
    if (Date.now() > until) {
      const log = await call(program, ["logs", "--tail", "15", name]).catch(() => "");
      throw new Error(`The machine did not list ${id} within ${ANSWER_WITHIN / 1000} seconds. Its log ends:\n${log.trim()}`);
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

/** The uid of the base image's runtime user (machine/Dockerfile), who is this computer's user in a machine that writes here. */
const RUNTIME_UID = 1000;

/**
 * Makes the agent's machine, or makes it over when its definition, this
 * copy's settings or its image have changed since, and starts it: a container
 * called `chloe-<id>`, its volumes `chloe-<id>-data` and `chloe-<id>-work`,
 * the agent's folder at `workspace/routines` (read only, unless the folder is
 * a repository of its own), what it lends at the same paths, its config, and
 * its keys in its .env. A machine already as the definition says is only
 * started. Answers once the machine lists the agent. The volumes are never
 * removed: a machine made over keeps its memory, its runs and its work.
 */
export async function readyMachine(agent: DefinedAgent): Promise<MachineAddress> {
  const sandbox = agent.workspace!.sandbox!;
  const program = sandbox.type;
  if (settings.machine.own) throw new Error(`${agent.id} runs in a machine of its own, and this copy is itself in one.`);
  if (program !== "podman" && program !== "docker") throw new Error(`${agent.id}'s sandbox is ${JSON.stringify(program)}: it is "podman" or "docker".`);
  if (!(await installed(program))) throw new Error(`${agent.id} runs in ${program}, which is not installed here.`);

  const name = `chloe-${agent.id}`;
  const key = await keyFor(agent.id);
  const lend = Object.entries(sandbox.lend ?? {});
  for (const [path, how] of lend) {
    if (!isAbsolute(path)) throw new Error(`${agent.id} lends ${path}: say the whole path, from /.`);
    if (!existsSync(path)) throw new Error(`${agent.id} lends ${path}, which is not here.`);
    if (how !== "read" && how !== "write") throw new Error(`${agent.id} lends ${path} as ${JSON.stringify(how)}: it is "read" or "write".`);
  }
  const ownRepo = await isRepoTop(agent.folder);
  const sameUser = program === "podman" && (ownRepo || lend.some(([, how]) => how === "write"));

  const filesystem = agent.workspace!.filesystem ?? { type: "volume" };
  if (filesystem.type === "local" && !(existsSync(filesystem.path) && statSync(filesystem.path).isDirectory())) {
    throw new Error(`${agent.id}'s filesystem is ${filesystem.path}, which is not a folder here.`);
  }
  const work = filesystem.type === "local" ? filesystem.path : `${name}-work`;

  const { config, env } = machineConfig(agent.id, key);
  for (const [one, value] of Object.entries(sandbox.env ?? {})) env[one] = value;
  const keys = [...settings.machine.keys, ...(sandbox.keys ?? [])];
  const absent = keys.filter((one) => !process.env[one]);
  if (absent.length) throw new Error(`${agent.id}'s machine is to have ${absent.join(", ")}, which .env does not set.`);
  for (const one of keys) env[one] = process.env[one]!;
  const setup = sandbox.setup ? await readFile(resolve(agent.folder, sandbox.setup), "utf8").catch(() => undefined) : "";
  if (setup === undefined) throw new Error(`${agent.id}'s sandbox runs ${sandbox.setup}, and there is no such file in its folder.`);

  const image = await imageFor(agent, sandbox);
  const mounts = [
    `${name}-data:/home/runtime/data`,
    `${work}:/home/runtime/workspace`,
    `${agent.folder}:/home/runtime/workspace/routines${ownRepo ? "" : ":ro"}`,
    ...lend.map(([path, how]) => `${path}:${path}${how === "read" ? ":ro" : ""}`),
  ];
  // Keyed on the machine's own key, so the label says nothing of the secrets it covers.
  const made = createHmac("sha256", key).update(JSON.stringify({ image, mounts, sameUser, config, env, setup })).digest("hex").slice(0, 16);

  const start = startCommand(program, name);
  const now = await inspect(program, name);
  if (now?.made === made && now.port) {
    const address = `http://127.0.0.1:${now.port}`;
    if (!now.running) await call(start[0], start.slice(1));
    await listed(program, name, address, key, agent.id);
    return { address, key, start };
  }

  const port = now?.port || (await freePort(program));
  const address = `http://127.0.0.1:${port}`;
  console.log(`${agent.id}: making its machine, ${name}, on ${address}`);
  if (now) {
    await call(program, ["stop", "--time", "30", name]).catch(() => undefined);
    await call(program, ["rm", "--force", name]);
  }
  const folder = await mkdtemp(join(tmpdir(), "chloe-machine-"));
  try {
    await call(program, [
      "create", "--name", name, "--label", `chloe.agent=${agent.id}`, "--label", `chloe.made=${made}`,
      ...(sameUser ? [`--userns=keep-id:uid=${RUNTIME_UID},gid=${RUNTIME_UID}`, "--user", "root"] : []),
      "--cap-add=NET_ADMIN", "--cap-add=SYS_ADMIN",
      "--publish", `127.0.0.1:${port}:3067`,
      ...mounts.flatMap((one) => ["--volume", one]),
      image,
    ]);
    // The start script hands both files to chloe's user, and keeps .env to it alone.
    await writeFile(join(folder, "chloe.config.ts"), config, { mode: 0o644 });
    await writeFile(join(folder, ".env"), Object.entries(env).map(([one, value]) => `${one}=${value}`).join("\n") + "\n", { mode: 0o600 });
    await call(program, ["cp", join(folder, "chloe.config.ts"), `${name}:/home/runtime/chloe.config.ts`]);
    await call(program, ["cp", join(folder, ".env"), `${name}:/home/runtime/.env`]);
    await call(start[0], start.slice(1));
    if (sandbox.setup) {
      console.log(`${agent.id}: running ${sandbox.setup} in its machine`);
      // Once the start script has handed .env to chloe's user.
      await call(program, ["exec", "-u", "runtime", name, "sh", "-c", "for i in $(seq 60); do [ -r /home/runtime/.env ] && exit 0; sleep 0.5; done; exit 1"]);
      await call(program, [
        "exec", "-u", "runtime", "-e", "HOME=/home/runtime", "-w", "/home/runtime/workspace/routines", name,
        "sh", "-c", 'set -a; . /home/runtime/.env; set +a; exec sh "$0"', sandbox.setup,
      ], undefined, 30 * 60_000);
      await call(program, ["stop", "--time", "30", name]);
      await call(start[0], start.slice(1));
    }
    await listed(program, name, address, key, agent.id);
  } catch (error) {
    // Its volumes stay. Without the container, the next try makes it again.
    await call(program, ["rm", "--force", name]).catch(() => undefined);
    throw error;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  if (isFile(sandbox.image ?? settings.machine.image)) await forgetOldImages(program, agent.id, image);
  console.log(`${agent.id}: its machine is ready, on ${address}`);
  return { address, key, start };
}
