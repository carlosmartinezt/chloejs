// Setting chloe up, one question at a time.
//
//   npx chloe setup
//   npx chloe setup --agent postie   names the first agent rather than asking
//   npx chloe setup --yes            takes every default and asks nothing
//
// It writes the files a project needs, puts the server on a free port, asks
// which model to use and checks that model actually answers, and runs the
// starter agent's first job. Every answer has a default, so holding Enter
// through it works. It sets no password: the server prints a link that opens
// the page signed in, and a password is for later, if ever.
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

import { firstCommit, hasGit, hasGitName, repositoryOf, uncommittedIn } from "./git.ts";
import { GUIDES, identifier, modelLine, idProblem, STARTER_MODEL_LINE, starterFiles, withChannel, withSetting } from "./starter.ts";
import { ask, askHidden, pick, takeDefaults, yes } from "./terminal.ts";
import type { Provider } from "#chloe/core/settings";

/** The folder being set up: where the person ran the command. */
const HERE = process.cwd();

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

/** Every file this wrote or changed, in the order it happened. */
function written(path: string, what: string): void {
  wrote.push([path, what]);
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
      options: { agent: { type: "string" }, yes: { type: "boolean", short: "y" } },
      allowPositionals: true,
    });
    return values;
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\nnpx chloe setup takes --agent <id> and --yes, and nothing else.`);
    process.exit(1);
  }
})();

if (given.yes || nobodyHere) takeDefaults();

console.log(`Setting chloe up in ${HERE}.\n`);
if (nobodyHere) console.log("Nobody is at a keyboard here, so every question takes its default.\n");

// One line and not a stack: whatever went wrong, the person reading it is
// setting up a project and every step above this one already happened.
try {
  await theProject();
  const agent = await theAgent();
  const port = await thePort();
  const model = await theModel();
  await firstRun(agent);
  await onWhatsApp(agent);
  await somewhereToWatch(port);
  await theRepository(agent);
  await sayWhatNext(agent, model, port);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
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
    console.log("@chloejs/core is not installed here, and your agent files import it.");
    if (await yes("Run npm install @chloejs/core? (Y/n)", true)) {
      const done = spawnSync("npm", ["install", "@chloejs/core"], { cwd: HERE, stdio: "inherit" });
      if (done.status !== 0) {
        console.error("That did not work. Install it yourself, then run this again.");
        process.exit(1);
      }
    }
  }
}

/** The starter agent: its id, then every file it is made of. */
async function theAgent(): Promise<string> {
  // A config that is already there is somebody's own, so it is read and never
  // written: what it says about an agent decides whether this is that agent again.
  const configFile = join(HERE, "chloe.config.ts");
  const config = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const listed = (id: string) => config.includes(`agents/${id}/agent.ts`);
  if (config) console.log("chloe.config.ts is already here, so this leaves it alone.\n");

  /** What is wrong with `said` as the new agent's id, or "" when nothing is. */
  const wrongId = (said: string) =>
    idProblem(said) ||
    (existsSync(join(HERE, "agents", said)) && !listed(said) ? `agents/${said} is there already and chloe.config.ts does not list it. Pick another.` : "");

  let id = given.agent ?? "";
  if (id && wrongId(id)) throw new Error(`--agent ${id}: ${wrongId(id)}`);
  while (!id) {
    const said = (await ask("What is your first agent called? (starter) ")).trim() || "starter";
    const problem = wrongId(said);
    if (problem) console.log(`  ${problem}`);
    else id = said;
  }

  for (const file of starterFiles(id)) {
    const path = join(HERE, file.path);
    if (file.add) {
      // A file the project may have already, added to and never replaced, so
      // a project with its own .gitignore or AGENTS.md keeps it.
      const held = existsSync(path) ? readFileSync(path, "utf8") : "";
      const gap = held && !held.endsWith("\n") ? "\n" : "";
      if (file.add === "lines") {
        const lines = file.body.trim().split("\n").filter((line) => !held.split("\n").includes(line));
        if (lines.length === 0) continue;
        appendFileSync(path, `${gap}${lines.join("\n")}\n`);
        written(file.path, `${lines.join(", ")} added`);
      } else {
        if (held.split("\n").includes(file.body.split("\n")[0])) continue;
        appendFileSync(path, held ? `${gap}\n${file.body}` : file.body);
        written(file.path, held ? "added to" : "written");
      }
      continue;
    }
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.body);
    written(file.path, "written");
    if (file.path === "chloe.config.ts") configWritten = true;
  }

  if (config && !listed(id)) {
    console.log(`\nagents/${id} is written. chloe.config.ts is yours, so add it there:`);
    console.log(`  import ${identifier(id)} from "./agents/${id}/agent.ts";`);
    console.log(`  export default defineConfig({ agents: [${identifier(id)}] });`);
  }
  console.log(`\n${id} has two jobs: daily-note is code and asks no model, summary is a prompt and asks one.\n`);
  return id;
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
 * Returns the port, and whether it is the default.
 */
async function thePort(): Promise<{ port: number; moved: boolean }> {
  const { settings } = await import("#chloe/core/settings");
  const { host, port } = settings.serve;
  if (!configWritten || !(await taken(host, port))) return { port, moved: false };
  for (let next = port + 1; next < port + 100; next++) {
    if (await taken(host, next)) continue;
    inSettings(`serve: { port: ${next} },`);
    console.log(`Port ${port} is taken here, most likely by another chloe, so this one listens on ${next}.\n`);
    return { port: next, moved: true };
  }
  console.log(`Ports ${port} to ${port + 99} are all taken here. Set serve.port in chloe.config.ts to a free one before npx chloe.\n`);
  return { port, moved: true };
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

  const choice = await pick("\nA model. Only the prompt job asks one, so this can wait: the code job runs either way.", [
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
  console.log(trouble || "it answered, and it can call a tool.");
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
 * The starter agent's code job, run here so the first thing that happens is a
 * run and not a page. It asks no model, so it works before any of the above
 * did, and it costs nothing.
 *
 * The clock is not started and no channel is opened, so this is one writer for
 * one run even if the service is already going.
 */
async function firstRun(id: string): Promise<void> {
  console.log(`\nRunning ${id}/daily-note, which asks no model.`);
  try {
    const { load } = await import("#chloe/load/load");
    const { work } = await import("#chloe/core/steps");
    const agent = await load(id);
    const job = agent.jobs.find((one) => one.id === "daily-note");
    if (!job) return void console.log("  it is not there any more, so nothing ran.");

    const result = await work({ agent, job, source: "terminal" });
    console.log(`  ${result.steps} steps, $${result.cost.toFixed(4)}, and a line in ${agent.memory.folder}/days.md`);
  } catch (error) {
    console.log(`  it did not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * WhatsApp. A number registered with Meta, and an address they post each
 * message to, so this is the one channel that needs the box reachable from
 * outside. Three things to paste, and the channel is written into the agent.
 *
 * Holding Enter skips it, because it asks for things nobody has to hand, and an
 * empty answer on a second run keeps whatever is already there.
 */
async function onWhatsApp(agent: string): Promise<void> {
  console.log("\nWhatsApp. It answers as a number registered with Meta, which cannot be a number already in the app.");
  console.log("Meta posts each message to an address, so chloe keeps a post box somewhere else and collects from it.");
  console.log("Nothing here is opened, and the post box can neither read a message nor make one up.");
  if (!(await yes("Set it up now? (y/N)", false))) return;

  console.log("\nAt developers.facebook.com: make an app, add WhatsApp to it, and it hands you a number to try with.");
  console.log("The token on that page lasts a day. A permanent one comes from a system user with whatsapp_business_messaging.");
  // What is already there, so a second run can be held through without
  // blanking a token: an empty answer keeps the one in the file.
  const { nameInEnv } = await import("#chloe/core/settings");
  const name = (what: string) => nameInEnv(["agents", agent, "whatsapp", what]);
  const had = (what: string) => process.env[name(what)] ?? "";
  const keep = (what: string) => (had(what) ? " (or Enter to keep the one there)" : "");
  const phoneNumberId = (await ask(`The number's id, called phone_number_id there${keep("phone_number_id") || " (or Enter to skip)"}: `)).trim() || had("phone_number_id");
  if (!phoneNumberId) return void console.log(`  Nothing written. Put ${name("phone_number_id")} in .env when you want it.`);
  const token = (await askHidden(`Paste a token for it${keep("token")}: `)).trim() || had("token");
  const appSecret = (await askHidden(`Paste the app's secret, which signs everything WhatsApp posts in${keep("app_secret")}: `)).trim() || had("app_secret");
  for (const [what, value] of Object.entries({ phone_number_id: phoneNumberId, token, app_secret: appSecret })) {
    putInEnv(name(what), value);
  }
  written(".env", `${name("phone_number_id")} and the two beside it, mode 600`);
  inSettings(
    `agents: { ${JSON.stringify(agent)}: { whatsapp: { phone_number_id: process.env.${name("phone_number_id")}, ` +
      `token: process.env.${name("token")}, app_secret: process.env.${name("app_secret")} } } },`,
  );
  channelIn(agent, 'import { whatsappChannel } from "@chloejs/core/channels";', "whatsappChannel({ allowFrom: [] })");
  console.log("\nStart chloe and it writes one address to the log, its own post box. Paste that into the app's WhatsApp");
  console.log("page, subscribed to messages, and WhatsApp posts there while chloe collects from it. Nothing is opened here.");
  console.log("allowFrom is empty, so the first message is answered with the sender's number, which is what goes in it.");
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
 * Writes a channel into the agent's own file, or says the two lines to add when
 * the file already has channels of its own. A file that already names this one
 * is left alone and said to be, because setup is run again and again and the
 * second run should not ask for a line that is already in there.
 */
function channelIn(agent: string, importLine: string, entry: string): void {
  const where = join("agents", agent, "agent.ts");
  const path = join(HERE, where);
  const held = existsSync(path) ? readFileSync(path, "utf8") : "";
  const channel = `${entry.split("(")[0]}(`;
  if (held.includes(channel)) return void console.log(`\n${where} is already on it, so it is left alone.`);
  const added = withChannel(held, importLine, entry);
  if (!added) {
    console.log(`\n${where} is yours, so add these two lines to it:`);
    console.log(`  ${importLine}`);
    console.log(`  channels: [${entry}],`);
    return;
  }
  writeFileSync(path, added);
  written(where, "the channel added");
}

/** Where the runs are watched from: this box always, and dashboard.chloejs.org as well if they want. */
async function somewhereToWatch({ port }: { port: number }): Promise<void> {
  const where = await pick("\nSomewhere to watch it from:", [
    { key: "here", what: `this box only, at 127.0.0.1:${port}` },
    { key: "remote", what: "a workspace on dashboard.chloejs.org as well, which needs nothing open on this box" },
  ]);

  if (where === "remote") {
    console.log("\nMake a workspace at https://dashboard.chloejs.org and paste the key it shows you once.");
    console.log("It connects out and stays connected, so there is no port to open and no name to point anywhere.");
    const key = (await askHidden("Paste the workspace key (or Enter to do it later): ")).trim();
    if (key) {
      putInEnv("CHLOE_DASHBOARD_REMOTE_API_KEY", key);
      written(".env", "CHLOE_DASHBOARD_REMOTE_API_KEY, mode 600");
      inSettings("dashboard: { remote: { api_key: process.env.CHLOE_DASHBOARD_REMOTE_API_KEY } },");
    }
  }
}

/**
 * A git repository for the project, with what setup wrote committed, because
 * every change an agent makes to itself is a commit and a file nobody has
 * committed is one it may not change. A folder that is not one yet is made one,
 * if they say so; one that is somebody's own is never committed to, only said.
 * git is never installed from here.
 */
async function theRepository(id: string): Promise<void> {
  if (!hasGit()) {
    console.log(`\ngit is not installed. Every change ${id} makes to itself is a git commit you can read and undo, so`);
    console.log(`without git it cannot change itself. Install it (https://git-scm.com/downloads), then run npx chloe setup again.`);
    return;
  }
  if (!repositoryOf(HERE)) {
    if (!(await yes(`\nMake this folder a git repository, so every change ${id} makes to itself can be read and undone? (Y/n)`, true))) {
      console.log(`  Left as it is. ${id} cannot change itself until it is one: git init, then commit what is here.`);
      return;
    }
    firstCommit(HERE);
    written(".git", "a repository, with what is here as its first commit");
  } else {
    const waiting = uncommittedIn(HERE, [join("agents", id)]);
    if (waiting.length) {
      console.log(`\n${id}'s files are not committed, and it may not change a file nobody has committed. Commit them:`);
      console.log(`  git add agents/${id} && git commit -m "${id}, from npx chloe setup"`);
    }
  }
  if (!hasGitName(HERE)) {
    console.log("\ngit has no name to commit under here, which what you change in an agent's memory by hand is committed under:");
    console.log('  git config --global user.name "Your Name"');
    console.log("  git config --global user.email you@example.com");
  }
}

async function sayWhatNext(id: string, model: string, { port, moved }: { port: number; moved: boolean }): Promise<void> {
  if (wrote.length) console.log(`\nWritten:\n${columns(wrote)}`);
  console.log(
    `\nTry these:\n${columns([
      ["npx chloe", "the server: every cron line, the page, the API, and a link that opens the page signed in"],
      [`npx chloe agent ${id}`, "talk to it in this terminal, once the server is going"],
      ...(model ? ([[`npx chloe agent ${id} summary`, "run the prompt job now"]] as [string, string][]) : []),
      // A machine runs one chloe service, and install points it at the folder
      // it is run from, so here it would move the other copy's.
      ...(moved ? [] : ([["npx chloe install", "keep it running after you close this terminal"]] as [string, string][])),
    ])}`,
  );
  if (moved) console.log("\nnpx chloe install is left out: a machine runs one chloe service, most likely the one already running, and install would point it here instead.");
  console.log(`\nTalk to ${id} on the page once npx chloe is going: http://127.0.0.1:${port}/agents/${id}/chat`);
  console.log(`Ask it for what you want done, like "every morning at 7, tell me what is most urgent in my mail".`);
  console.log(`\nWhat to write next, and every setting there is: ${GUIDES}`);
  // Whoever ran this without a keyboard is most likely a coding agent, about to
  // build what somebody asked for, and the guides it needs are already here.
  if (nobodyHere) {
    console.log("To show the person the page: start npx chloe in the background, leave it running, and give them the link it prints.");
    console.log("It opens the page signed in, with no password to set. npx chloe link prints another.");
    console.log(`Read the guides above before writing any code: they are for this version. AGENTS.md here says so for later sessions.`);
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
