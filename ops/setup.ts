// Setting chloe up, one question at a time.
//
//   npx chloe setup
//   npx chloe setup --yes            takes every default and asks nothing
//
// It writes the files a project needs, with a first agent that has nothing but
// instructions, so there is something to talk to on the page that changes
// itself when asked. It installs TypeScript, puts the server on a free port,
// and asks which model to use and checks that model actually answers. Every
// answer has a default, so holding Enter through it works. It sets no
// password: the server prints a link that opens the page signed in, and a
// password is for later, if ever.
//
// With nothing on stdin, which is how a script or a coding agent runs it, it
// behaves as --yes.
//
// Run it again later and it says what is already there and leaves it alone.
//
// Nothing here is imported by the service. It reads no setting as it loads,
// because it runs before there is a chloe.config.ts to find the settings from,
// and every file that reads one needs that. So the runtime is imported inside
// the steps that need it, once the files exist.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { firstCommit, hasGit, hasGitName, repositoryOf } from "./git.ts";
import { DEV_PACKAGES, GUIDES, modelLine, STARTER_AGENT, STARTER_MODEL_LINE, starterFiles, withSetting } from "./starter.ts";
import { ask, askHidden, pick, takeDefaults, yes } from "./terminal.ts";
import type { Provider } from "#chloe/core/settings";
import { bold, cyan, dim, green, red, yellow } from "#chloe/core/style";

/** The folder being set up: where the person ran the command. */
const HERE = process.cwd();

/** The guides on the site, which a person is sent to. A coding agent is sent to `GUIDES`, the copy for this version. */
const SITE_GUIDES = "https://chloejs.org/docs";

/** Free models, and every provider through one key. Written only if they ask for it. */
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/** How each provider is called in a sentence. */
const SAID: Record<Provider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/** The name each provider's own tools read its key from, which is where somebody who has one already keeps it. */
const OWN_KEY_NAMES: Record<Provider, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

/** The model offered first on each provider's own key. */
const OWN_DEFAULT: Record<Provider, string> = { anthropic: "anthropic/claude-sonnet-5", openai: "openai/gpt-6-luna" };

/** What was written, said once at the end rather than line by line as it happens. */
const wrote: [string, string][] = [];

/** Whether this run wrote chloe.config.ts, and so may choose what it says. */
let configWritten = false;

/** Whether this run wrote the first agent, which the last lines then name. */
let agentWritten = false;

/** Every file this wrote or changed, in the order it happened. */
function written(path: string, what: string): void {
  wrote.push([path, what]);
}

/** A heading between the parts of setup, so each question stands apart from what came before it. */
function section(title: string): void {
  const width = Math.min(process.stdout.columns || 64, 64);
  console.log(`\n${dim("──")} ${bold(title)} ${dim("─".repeat(Math.max(2, width - title.length - 4)))}\n`);
}

/** Two columns, the first as wide as its widest line. */
function columns(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join("\n");
}

/** Whether a person is at a keyboard to answer. */
const nobodyHere = !process.stdin.isTTY;

/**
 * What was said on the command line. Words are let through, because `cli.ts`
 * runs this for "setup" and for any other word typed in a folder with no config.
 */
const given = (() => {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { yes: { type: "boolean", short: "y" } },
      allowPositionals: true,
    });
    return values;
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\nnpx chloe setup takes --yes, and nothing else.`);
    process.exit(1);
  }
})();

if (given.yes || nobodyHere) takeDefaults();

// What is done before the first question is said in lines indented under this one.
console.log(`\n${bold(`Setting chloe up in ${HERE}`)}`);
if (nobodyHere) console.log("  Nobody is at a keyboard here, so every question takes its default.");

// One line and not a stack: whatever went wrong, the person reading it is
// setting up a project and every step above this one already happened.
try {
  await theProject();
  await theFiles();
  const moved = await thePort();
  await theModel();
  await theRepository();
  sayWhatNext(moved);
} catch (error) {
  console.error(`\n${red(error instanceof Error ? error.message : String(error))}`);
  if (wrote.length) console.error(`\nWhat was written before that:\n${columns(wrote)}`);
  console.error("\nRun npx chloe setup again: it leaves what is already there alone.");
  process.exit(1);
}

/**
 * package.json, which has to be there, and the one line in it node needs. An
 * agent file is TypeScript that node reads directly, and without this it reads
 * one as CommonJS, which works until a file happens to parse both ways.
 */
async function theProject(): Promise<void> {
  const path = join(HERE, "package.json");
  if (!existsSync(path)) {
    console.error("There is no package.json here. Run npm init -y first, then this again.");
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(path, "utf8")) as { type?: string };
  if (pkg.type !== "module") {
    writeFileSync(path, `${JSON.stringify({ ...pkg, type: "module" }, null, 2)}\n`);
    written("package.json", '"type": "module"');
  }

  if (!existsSync(join(HERE, "node_modules/@chloejs/core"))) {
    const failed = install(["@chloejs/core"], "which your agent files import");
    if (failed) {
      console.error(`Run ${failed} yourself, then this again.`);
      process.exit(1);
    }
  }

  // Chloe runs without these, because node strips the types itself. Without
  // them an editor underlines process in chloe.config.ts, and an agent's own
  // change to its code is not type checked before it goes live.
  const missing = DEV_PACKAGES.filter((one) => !existsSync(join(HERE, "node_modules", one)));
  if (missing.length) {
    const failed = install(missing, "so your editor and chloe can check the code", true);
    if (failed) console.log(yellow(`  Chloe runs without them. Run ${failed} when you can.`));
  }
}

/** Which program installs packages here: the one whose lockfile is in the folder, or npm. */
function installer(): string {
  const locks: Record<string, string> = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun", "bun.lockb": "bun" };
  return Object.entries(locks).find(([file]) => existsSync(join(HERE, file)))?.[1] ?? "npm";
}

/**
 * Installs packages with the project's own installer, said in one line rather
 * than in the installer's words, which are shown only when it fails. `why` is
 * what they are for.
 *
 * Returns "" when it worked, or the command that failed, for the person to run.
 */
function install(packages: string[], why: string, dev = false): string {
  const using = installer();
  const command = [using, using === "npm" ? "install" : "add", ...(dev ? ["-D"] : []), ...packages];
  process.stdout.write(`  Installing ${packages.join(" and ")}, ${why}... `);
  const done = spawnSync(using, command.slice(1), { cwd: HERE, encoding: "utf8" });
  if (done.status === 0) {
    console.log(green("done"));
    return "";
  }
  console.log(red("that did not work:"));
  const said = (done.stderr || done.error?.message || "no reason given").trim().split("\n").slice(-5);
  for (const one of said) console.log(dim(`    ${one}`));
  return command.join(" ");
}

/**
 * chloe.config.ts with the first agent, and the files beside it. A config
 * already here is somebody's own and is left alone, and so no agent is written
 * for it to list.
 */
async function theFiles(): Promise<void> {
  if (existsSync(join(HERE, "chloe.config.ts"))) console.log("  chloe.config.ts is already here, so this leaves it alone.");

  for (const file of starterFiles()) {
    const path = join(HERE, file.path);
    if (file.add) {
      // A file the project may have already, added to and never replaced, so
      // a project with its own .gitignore keeps it.
      const held = existsSync(path) ? readFileSync(path, "utf8") : "";
      const gap = held && !held.endsWith("\n") ? "\n" : "";
      const lines = file.body.trim().split("\n").filter((line) => !held.split("\n").includes(line));
      if (lines.length === 0) continue;
      appendFileSync(path, `${gap}${lines.join("\n")}\n`);
      written(file.path, `${lines.join(", ")} added`);
      continue;
    }
    if (existsSync(path) || (file.withConfig && !configWritten)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.body);
    written(file.path, "written");
    if (file.path === "chloe.config.ts") configWritten = true;
    if (file.withConfig) agentWritten = true;
  }
}

/** Whether something on this machine already listens on that port. */
function taken(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const trying = createServer();
    trying.once("error", () => done(true));
    trying.listen(port, host, () => trying.close(() => done(false)));
  });
}

/**
 * The port the server listens on: the default, or the first free one after it
 * when something already has it, most often another chloe. Only for a config
 * this run wrote: one that was here already says what it wants, and a copy of
 * this project that is running holds its own port.
 *
 * Returns whether the default was taken.
 */
async function thePort(): Promise<boolean> {
  const { settings } = await import("#chloe/core/settings");
  const { host, port } = settings.serve;
  if (!configWritten || !(await taken(host, port))) return false;
  for (let next = port + 1; next < port + 100; next++) {
    if (await taken(host, next)) continue;
    inSettings(`serve: { port: ${next} },`);
    console.log(`  Port ${port} is taken, most likely by another chloe, so this one will use ${next}.`);
    return true;
  }
  console.log(yellow(`  Ports ${port} to ${port + 99} are all taken here. Set serve.port in chloe.config.ts to a free one before npx chloe.`));
  return true;
}

/**
 * Which model, and whether it answers. The choice goes in chloe.config.ts and
 * only the key goes in .env.
 *
 * Returns the model an agent asks here, or "" when there is none yet.
 */
async function theModel(): Promise<string> {
  const { runnable } = await import("#chloe/model/model");
  const { nameInEnv, PROVIDERS, settings } = await import("#chloe/core/settings");

  const held = ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY", "CHLOE_MODEL_KEY"].find((name) => process.env[name]);
  // A provider's key under the name its own tools read, or the one setup writes.
  const heldOwn = PROVIDERS.flatMap((provider) => {
    const name = [OWN_KEY_NAMES[provider], nameInEnv(["model", "keys", provider])].find((one) => process.env[one]);
    return name ? [{ provider, name }] : [];
  });

  section("Model");
  const choice = await pick("How should your agents reach a model? You can set this up later.", [
    ...(runnable("claude") ? [{ key: "claude" as const, what: "your Claude subscription, through the claude command on this box" }] : []),
    ...(runnable("codex") ? [{ key: "codex" as const, what: "your ChatGPT plan, through the codex command on this box" }] : []),
    ...(runnable("opencode") ? [{ key: "opencode" as const, what: "whatever opencode is signed in to on this box" }] : []),
    ...heldOwn.map(({ provider, name }) => ({ key: provider, what: `your ${SAID[provider]} key, already in ${name} in your environment, charged per call` })),
    ...(held ? [{ key: "held" as const, what: `the key already in ${held} in your environment` }] : []),
    { key: "free" as const, what: "a free key from OpenRouter: no card, and rate limited to a few runs an hour" },
    { key: "own" as const, what: "a key from Anthropic or OpenAI, charged per call to that account" },
    { key: "key" as const, what: "a gateway key of your own (Vercel AI Gateway, OpenRouter, anything of that shape)" },
    { key: "later" as const, what: "nothing yet" },
  ]);

  // No `preferredRoute` written for these: a subscription is already ahead of a key in
  // the order, so choosing one is choosing the model it runs.
  if (choice === "claude") return await settle({ defaultModel: "anthropic/claude-sonnet-5" });
  if (choice === "codex") return await settle({ defaultModel: "openai/gpt-6-luna" });
  if (choice === "opencode") {
    const { opencodeModels } = await import("#chloe/model/opencode");
    const [first] = opencodeModels();
    if (!first) {
      console.log("\nopencode is here but signed in to nothing. Run: opencode providers");
      return await settle({ defaultModel: "openrouter/free", gatewayUrl: OPENROUTER, judgeModel: "openrouter/free", namingModel: "openrouter/free" });
    }
    const asked = (await ask(`Which of opencode's models? (${first}) `)).trim();
    return await settle({ defaultModel: asked || first });
  }

  const found = heldOwn.find((one) => one.provider === choice);
  if (found) return await onOwnKey(found.provider, undefined, found.name);

  if (choice === "own") {
    const key = (await askHidden("Paste the key: ")).trim();
    // Anthropic's keys start sk-ant-, OpenAI's sk-, which is enough to tell
    // them apart without asking.
    const guessed: Provider | undefined = key.startsWith("sk-ant-") ? "anthropic" : key.startsWith("sk-") ? "openai" : undefined;
    const asked = guessed ?? (await ask(`Whose key is it, ${PROVIDERS.join(" or ")}? (${PROVIDERS[0]}) `)).trim().toLowerCase();
    const provider = (PROVIDERS as readonly string[]).includes(asked) ? (asked as Provider) : PROVIDERS[0];
    return await onOwnKey(provider, key || undefined, nameInEnv(["model", "keys", provider]));
  }

  if (choice === "held") {
    const asked = (await ask(`Which model? (${settings.model.defaultModel || "openrouter/free"}) `)).trim();
    const model = asked || settings.model.defaultModel || "openrouter/free";
    // The key stays under the name it has, and the config names that.
    return await settle(
      { defaultModel: model, gatewayUrl: model.startsWith("openrouter/") ? OPENROUTER : settings.model.gatewayUrl },
      undefined,
      held,
    );
  }

  // Something loadable either way: an agent that names no model and has no
  // default is refused as it loads, so a project with no key would not start.
  if (choice === "later") return await settle({ defaultModel: "openrouter/free", gatewayUrl: OPENROUTER, judgeModel: "openrouter/free", namingModel: "openrouter/free" });

  if (choice === "free") {
    console.log("\nMake a key at https://openrouter.ai/keys. A free account with no card is enough.");
    console.log("openrouter/free is one model id that picks a free model and only ones that can call a tool.");
    const key = (await askHidden("Paste the key (or Enter to do it later): ")).trim();
    return await settle({ defaultModel: "openrouter/free", gatewayUrl: OPENROUTER, judgeModel: "openrouter/free", namingModel: "openrouter/free" }, key || undefined);
  }

  const gateway = (await ask(`Which gateway? (${settings.model.gatewayUrl}) `)).trim() || settings.model.gatewayUrl;
  const model = (await ask("Which model, provider first, like anthropic/claude-sonnet-5? ")).trim();
  const key = (await askHidden("Paste the key: ")).trim();
  // The gateway first, because somebody who just pasted a key meant to use it,
  // and a subscription on this box would otherwise be ahead of it in the order.
  return await settle({ defaultModel: model, gatewayUrl: gateway, preferredRoute: "gateway,claude,codex,opencode,direct" }, key);
}

/**
 * A provider's own key, pasted (`key`) or already in the environment, kept
 * under `named` and read by the config as `model.keys`. The direct route goes
 * first, because somebody who chose a key meant to use it, and a subscription
 * on this box would otherwise be ahead of it in the order. The default judge
 * and namer are Anthropic's, so on any other provider they are the chosen
 * model too.
 */
async function onOwnKey(provider: Provider, key: string | undefined, named: string): Promise<string> {
  const asked = (await ask(`Which model? (${OWN_DEFAULT[provider]}) `)).trim();
  const model = asked ? (asked.includes("/") ? asked : `${provider}/${asked}`) : OWN_DEFAULT[provider];
  const others: Record<string, string> = provider === "anthropic" ? {} : { judgeModel: model, namingModel: model };
  return await settle({ defaultModel: model, ...others, preferredRoute: "direct,claude,codex,opencode,gateway" }, key, named, ["keys", provider]);
}

/**
 * Writes the model settings, then asks that model one thing to find out whether
 * any of it was true. A wrong key, an unauthorised CLI and a model name that has
 * been retired all look the same until something asks.
 *
 * The choice goes in chloe.config.ts and the key in .env, under `named`, which
 * the config's model line reads as `process.env.` that name, at `where` under
 * `model`: the gateway's key unless it says otherwise. A config this did not
 * write is somebody's own and is told rather than edited.
 */
async function settle(model: Record<string, string>, key?: string, named = "CHLOE_MODEL_KEY", where: string[] = ["key"]): Promise<string> {
  const { declareSettings } = await import("#chloe/core/settings");
  const { loadEnv } = await import("#chloe/core/env");
  if (key) {
    putInEnv(named, key);
    written(".env", `${named}, mode 600`);
  }
  loadEnv();

  const line = modelLine(model, named, where);
  const configFile = join(HERE, "chloe.config.ts");
  const config = readFileSync(configFile, "utf8");
  if (config.includes(STARTER_MODEL_LINE)) {
    writeFileSync(configFile, config.replace(STARTER_MODEL_LINE, line));
    written("chloe.config.ts", line);
  } else if (!config.includes(line)) {
    console.log(`\nchloe.config.ts is yours, so put this in its settings:\n  ${line}`);
  }

  // What the config declares, with the choice on top, so the check below runs on
  // it whether or not the line went in. A fresh address, because the config may
  // have been imported before it was written.
  const declared = (await import(`${pathToFileURL(configFile).href}?setup=${Date.now()}`)).default as {
    settings?: Record<string, unknown>;
    agents?: { id?: string }[];
  };
  const settings = declared.settings ?? {};
  const preferredRoute = model.preferredRoute ? { preferredRoute: model.preferredRoute.split(",") } : {};
  const keyed = where.reduceRight<unknown>((inside, part) => ({ [part]: inside }), process.env[named]) as Record<string, unknown>;
  declareSettings(
    { ...settings, model: { ...(settings.model as object), ...model, ...preferredRoute, ...keyed } } as Parameters<typeof declareSettings>[0],
  );

  // Asked of the runtime rather than worked out here, so this cannot disagree
  // with what the first job will find: a key for the gateway or a provider, the program for a CLI.
  const { routeFor, runnable } = await import("#chloe/model/model");
  const asking = model.defaultModel;
  if (!runnable(routeFor(asking))) {
    console.log(`\nNothing here can run ${asking} yet, so nothing was asked.`);
    console.log(`Put a key in .env as ${named} when you have one, and it can.`);
    return "";
  }

  process.stdout.write(`\nAsking ${asking} one thing to make sure it answers... `);
  const trouble = await tryIt(asking);
  console.log(trouble ? red(trouble) : green("it answered, and it can call a tool."));
  if (trouble) console.log(`Fix that whenever you like: model in chloe.config.ts and ${named} in .env are all of it.`);
  return asking;
}

/**
 * One real call down whatever route was just chosen, asking for a tool rather
 * than for words. A model that cannot call a tool cannot run a prompt job, and
 * free models differ on that, so the check is worth the tenth of a penny.
 *
 * Returns what went wrong, or "" when nothing did.
 */
async function tryIt(model: string): Promise<string> {
  const { ask: askModel } = await import("#chloe/model/model");
  try {
    const answer = await askModel({
      model,
      maxOutputTokens: 300,
      messages: [
        { role: "system", content: "Use the tool. Say nothing else." },
        { role: "user", content: 'Call ready with word set to "chloe".' },
      ],
      tools: [
        {
          name: "ready",
          description: "Say one word back.",
          parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
        },
      ],
      signal: AbortSignal.timeout(120_000),
    });
    if (answer.toolCalls.length > 0) return "";
    if (answer.text.trim()) return "it answered, but it would not call the tool, so the prompt job will not work on it.";
    return "it said nothing at all.";
  } catch (error) {
    return `no: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Writes one line into chloe.config.ts's settings, or says it when the file is
 * somebody's own or already says it.
 */
function inSettings(line: string): void {
  const configFile = join(HERE, "chloe.config.ts");
  const config = readFileSync(configFile, "utf8");
  if (config.includes(line)) return;
  const added = withSetting(config, line);
  if (!added) return void console.log(`\nchloe.config.ts is yours, so put this in its settings:\n  ${line}`);
  writeFileSync(configFile, added);
  written("chloe.config.ts", line);
}

/**
 * A git repository for the project, because every change an agent makes to
 * itself is a commit. A folder that is not one yet is made one, with what is
 * here as its first commit, if they say so; one that is somebody's own is
 * never committed to. git is never installed from here.
 */
async function theRepository(): Promise<void> {
  if (!hasGit()) {
    section("Git");
    console.log(yellow("git is not installed."), "Every change an agent makes to itself is a git commit you can read and undo, so");
    console.log("without git it cannot change itself. Install it (https://git-scm.com/downloads), then run npx chloe setup again.");
    return;
  }
  const inOne = Boolean(repositoryOf(HERE));
  const named = hasGitName(HERE);
  if (inOne && named) return;

  section("Git");
  if (!inOne) {
    if (!(await yes("Make this folder a git repository, so every change an agent makes to itself can be read and undone?", true))) {
      console.log("  Left as it is. An agent cannot change itself until it is one: git init, then commit what is here.");
      return;
    }
    firstCommit(HERE);
    written(".git", "a repository, with what is here as its first commit");
  }
  if (!named) {
    console.log(`${inOne ? "" : "\n"}git has no name set here. What you change by hand in an agent is committed under it, so set one:`);
    console.log(`  ${cyan('git config --global user.name "Your Name"')}`);
    console.log(`  ${cyan("git config --global user.email you@example.com")}`);
  }
}

function sayWhatNext(moved: boolean): void {
  section("Done");
  if (wrote.length) console.log(`Written:\n${columns(wrote)}\n`);
  // Over SSH the page is opened on another computer, which loopback cannot reach.
  const start = process.env.SSH_CONNECTION ? "npx chloe --remote" : "npx chloe";
  console.log("Start chloe, and leave it running:\n");
  console.log(`    ${dim("$")} ${bold(cyan(start))}\n`);
  console.log(
    agentWritten
      ? `It prints a link to the page. Open it to talk to ${STARTER_AGENT}, your first agent, and ask it to change\nitself: its words, its jobs, its code.`
      : "It prints a link to the page, where you can talk to your agents.",
  );
  if (!nobodyHere) {
    console.log('\nYour coding agent can write agents too: ask it, in this folder, for "an agent that tells me every');
    console.log('morning at 7 what is most urgent in my mail".');
  }
  // A machine runs one chloe service, and install points it at the folder it
  // is run from, so here it would move the other copy's.
  if (moved) {
    console.log("\nAnother chloe probably runs on this computer already. npx chloe install keeps one chloe running per");
    console.log("computer, so running it here would replace that one.");
  } else {
    console.log(`\nTo keep it running after you close this terminal: ${cyan("npx chloe install")}`);
  }
  console.log(`\nGuides: ${SITE_GUIDES}`);
  // Whoever ran this without a keyboard is most likely a coding agent, about to
  // build what somebody asked for, and the guides it needs are already here.
  if (nobodyHere) {
    console.log(`\nThe guides for this version are in ${GUIDES}. Read them before writing any code.`);
    if (agentWritten) {
      console.log(`Setup wrote a first agent, agents/${STARTER_AGENT}. Make it the one they asked for, and as it has not run yet,`);
      console.log("give it an id that says what it does (postie for mail): its folder, its id and its line in chloe.config.ts.");
    }
    console.log(`Then start ${start} in the background and leave it running. It prints a link that signs the person in (npx chloe link prints another).`);
    console.log("When you are done, tell them this and nothing more, with that whole link, #in= and all:");
    console.log('  "I\'ve installed Chloe and written <agent id>. It\'s running at <link>. Open it and it will walk you through what\'s left.');
    console.log('  The link works once, within the hour: npx chloe link prints another."');
    console.log("The page says what each connection is missing and how to set it up, so do not explain it. Link a guide only as https://chloejs.org/docs/<name>.");
  }
}

/**
 * One line in .env beside chloe.config.ts, replacing that name if it is already
 * there. .env is for secrets only: a password, a key or a token.
 */
function putInEnv(name: string, value: string): void {
  const path = join(HERE, ".env");
  const held = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = held.split("\n").filter((line) => !line.trim().startsWith(`${name}=`));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  lines.push(`${name}=${value}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o600);
}
