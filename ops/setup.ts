// Setting chloe up, one question at a time.
//
//   npx chloe setup
//
// It writes the files a project needs, asks which model to use and checks that
// model actually answers, runs the starter agent's first job, and sets the one
// password. Every answer has a default, so holding Enter through it works.
//
// Run it again later and it says what is already there and leaves it alone.
//
// Nothing here is imported by the service. It reads no setting as it loads,
// because it runs before there is a chloe.config.ts to find the settings from,
// and every file that reads one needs that. So the runtime is imported inside
// the steps that need it, once the files exist.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { identifier, modelLine, nameProblem, STARTER_MODEL_LINE, starterFiles, withChannel } from "./starter.ts";
import { ask, askHidden, pick, setPassword, yes } from "./terminal.ts";

/** The folder being set up: where the person ran the command. */
const HERE = process.cwd();

/** Free models, and every provider through one key. Written only if they ask for it. */
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/** What was written, said once at the end rather than line by line as it happens. */
const wrote: [string, string][] = [];

/** Every file this wrote or changed, in the order it happened. */
function written(path: string, what: string): void {
  wrote.push([path, what]);
}

/** Two columns, the first as wide as its widest line. */
function columns(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join("\n");
}

if (!process.stdin.isTTY) {
  // Nothing to type into, so saying what it would ask beats hanging on a read
  // that never comes back.
  process.stdout.write(
    [
      "chloe setup asks questions, and nothing here can answer them.",
      "",
      "By hand, in this folder:",
      '  1  package.json needs "type": "module"',
      "  2  chloe.config.ts lists your agents and declares the settings, and one agent folder holds an agent.ts",
      "  3  .env beside it holds CHLOE_MODEL_KEY and every other credential",
      "  4  npx chloe account sets the one password",
      "",
      "All of it is at https://chloejs.org/docs/start",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

console.log(`Setting chloe up in ${HERE}.\n`);

// One line and not a stack: whatever went wrong, the person reading it is
// setting up a project and every step above this one already happened.
try {
  await theProject();
  const agent = await theAgent();
  const model = await theModel();
  await firstRun(agent);
  await onWhatsApp(agent);
  await somewhereToWatch();
  await thePassword();
  sayWhatNext(agent, model);
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

/** The starter agent: its name, then every file it is made of. */
async function theAgent(): Promise<string> {
  // A config that is already there is somebody's own, so it is read and never
  // written: what it says about an agent decides whether this is that agent again.
  const configFile = join(HERE, "chloe.config.ts");
  const config = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const named = (name: string) => config.includes(`agents/${name}/agent.ts`);
  if (config) console.log("chloe.config.ts is already here, so this leaves it alone.\n");

  let name = "";
  while (!name) {
    const said = (await ask("What is your first agent called? (starter) ")).trim() || "starter";
    const problem = nameProblem(said);
    if (problem) console.log(`  ${problem}`);
    else if (existsSync(join(HERE, "agents", said)) && !named(said)) {
      console.log(`  agents/${said} is there already and chloe.config.ts does not name it. Pick another name.`);
    } else name = said;
  }

  for (const file of starterFiles(name)) {
    const path = join(HERE, file.path);
    if (file.add) {
      // .gitignore: only the lines it does not have, so a project with its own
      // keeps it. data/ and .env are state and secrets.
      const held = existsSync(path) ? readFileSync(path, "utf8") : "";
      const lines = file.body.trim().split("\n").filter((line) => !held.split("\n").includes(line));
      if (lines.length === 0) continue;
      appendFileSync(path, `${held && !held.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
      written(file.path, `${lines.join(", ")} ignored`);
      continue;
    }
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.body);
    written(file.path, "written");
  }

  if (config && !named(name)) {
    console.log(`\nagents/${name} is written. chloe.config.ts is yours, so add it there:`);
    console.log(`  import ${identifier(name)} from "./agents/${name}/agent.ts";`);
    console.log(`  export default defineConfig({ agents: [${identifier(name)}] });`);
  }
  console.log(`\n${name} has two jobs: daily-note is code and asks no model, summary is a prompt and asks one.\n`);
  return name;
}

/**
 * Which model, and whether it answers. The choice goes in chloe.config.ts and
 * only the key goes in .env.
 *
 * Returns the model an agent asks here, or "" when there is none yet.
 */
async function theModel(): Promise<string> {
  const { runnable } = await import("#chloe/model/model");
  const { settings } = await import("#chloe/core/settings");

  const held = ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY", "CHLOE_MODEL_KEY"].find((name) => process.env[name]);

  const choice = await pick("\nA model. Only the prompt job asks one, so this can wait: the code job runs either way.", [
    ...(runnable("claude") ? [{ key: "claude" as const, what: "your Claude subscription, through the claude command on this box" }] : []),
    ...(runnable("codex") ? [{ key: "codex" as const, what: "your ChatGPT plan, through the codex command on this box" }] : []),
    ...(runnable("opencode") ? [{ key: "opencode" as const, what: "whatever opencode is signed in to on this box" }] : []),
    ...(held ? [{ key: "held" as const, what: `the key already in ${held} in your environment` }] : []),
    { key: "free" as const, what: "a free key from OpenRouter: no card, and rate limited to a few runs an hour" },
    { key: "key" as const, what: "a gateway key of your own (Vercel AI Gateway, OpenRouter, anything of that shape)" },
    { key: "later" as const, what: "nothing yet" },
  ]);

  // No `prefer` written for these: a subscription is already ahead of a key in
  // the order, so choosing one is choosing the model it runs.
  if (choice === "claude") return await settle({ default: "anthropic/claude-sonnet-5" });
  if (choice === "codex") return await settle({ default: "openai/gpt-6-luna" });
  if (choice === "opencode") {
    const { opencodeModels } = await import("#chloe/model/opencode");
    const [first] = opencodeModels();
    if (!first) {
      console.log("\nopencode is here but signed in to nothing. Run: opencode providers");
      return await settle({ default: "openrouter/free", gateway: OPENROUTER, judge: "openrouter/free", naming: "openrouter/free" });
    }
    const asked = (await ask(`Which of opencode's models? (${first}) `)).trim();
    return await settle({ default: asked || first });
  }

  if (choice === "held") {
    const asked = (await ask(`Which model? (${settings.model.default || "openrouter/free"}) `)).trim();
    const model = asked || settings.model.default || "openrouter/free";
    // A key under a name chloe already reads stays where it is. One under any
    // other name is written down, because otherwise nothing would read it.
    const { settingInEnv } = await import("#chloe/core/settings");
    const mine = settingInEnv(process.env, ["model", "key"]);
    return await settle(
      { default: model, gateway: model.startsWith("openrouter/") ? OPENROUTER : settings.model.gateway },
      mine ? undefined : process.env[held!],
    );
  }

  // Something loadable either way: an agent that names no model and has no
  // default is refused as it loads, so a project with no key would not start.
  if (choice === "later") return await settle({ default: "openrouter/free", gateway: OPENROUTER, judge: "openrouter/free", naming: "openrouter/free" });

  if (choice === "free") {
    console.log("\nMake a key at https://openrouter.ai/keys. A free account with no card is enough.");
    console.log("openrouter/free is one model id that picks a free model and only ones that can call a tool.");
    const key = (await askHidden("Paste the key (or Enter to do it later): ")).trim();
    return await settle({ default: "openrouter/free", gateway: OPENROUTER, judge: "openrouter/free", naming: "openrouter/free" }, key || undefined);
  }

  const gateway = (await ask(`Which gateway? (${settings.model.gateway}) `)).trim() || settings.model.gateway;
  const model = (await ask("Which model, provider first, like anthropic/claude-sonnet-5? ")).trim();
  const key = (await askHidden("Paste the key: ")).trim();
  // The gateway first, because somebody who just pasted a key meant to use it,
  // and a subscription on this box would otherwise be ahead of it in the order.
  return await settle({ default: model, gateway, prefer: "gateway,claude,codex,opencode" }, key);
}

/**
 * Writes the model settings, then asks that model one thing to find out whether
 * any of it was true. A wrong key, an unauthorised CLI and a model name that has
 * been retired all look the same until something asks.
 *
 * The choice goes in chloe.config.ts and the key in .env. A config this did not
 * write is somebody's own and is told rather than edited.
 */
async function settle(model: Record<string, string>, key?: string): Promise<string> {
  const { declareSettings, nameInEnv, reloadSettings } = await import("#chloe/core/settings");
  // Left by an earlier run of setup, and .env beats the config, so the old
  // choice would quietly win over the one just made.
  dropFromEnv(["default", "gateway", "prefer", "judge", "naming"].map((one) => nameInEnv(["model", one])));
  if (key) {
    putInEnv("CHLOE_MODEL_KEY", key);
    written(".env", "CHLOE_MODEL_KEY, mode 600");
  }
  reloadSettings();

  const line = modelLine(model);
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
    agents?: { name?: string }[];
  };
  const settings = declared.settings ?? {};
  const prefer = model.prefer ? { prefer: model.prefer.split(",") } : {};
  declareSettings(
    { ...settings, model: { ...(settings.model as object), ...model, ...prefer } } as Parameters<typeof declareSettings>[0],
    (declared.agents ?? []).map((one) => one?.name ?? "").filter(Boolean),
  );

  // Asked of the runtime rather than worked out here, so this cannot disagree
  // with what the first job will find: a key for the gateway, the program for a CLI.
  const { routeFor, runnable } = await import("#chloe/model/model");
  const asking = model.default;
  if (!runnable(routeFor(asking))) {
    console.log(`\nNothing here can run ${asking} yet, so nothing was asked.`);
    console.log("Put a key in .env as CHLOE_MODEL_KEY when you have one, and it can.");
    return "";
  }

  process.stdout.write(`\nAsking ${asking} one thing to make sure it answers... `);
  const trouble = await tryIt(asking);
  console.log(trouble || "it answered, and it can call a tool.");
  if (trouble) console.log("Fix that whenever you like: model in chloe.config.ts and CHLOE_MODEL_KEY in .env are all of it.");
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
      maxTokens: 300,
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
async function firstRun(name: string): Promise<void> {
  console.log(`\nRunning ${name}/daily-note, which asks no model.`);
  try {
    const { load } = await import("#chloe/load/load");
    const { work } = await import("#chloe/core/steps");
    const agent = await load(name);
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
  channelIn(agent, 'import { whatsappChannel } from "@chloejs/core/channels";', "whatsappChannel({ allowFrom: [] })");
  console.log("\nStart chloe and it writes one address to the log, its own post box. Paste that into the app's WhatsApp");
  console.log("page, subscribed to messages, and WhatsApp posts there while chloe collects from it. Nothing is opened here.");
  console.log("allowFrom is empty, so the first message is answered with the sender's number, which is what goes in it.");
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

/** Where the runs are watched from: a dashboard somewhere else, or this box. */
async function somewhereToWatch(): Promise<void> {
  const where = await pick("\nSomewhere to watch it from:", [
    { key: "cloud", what: "a workspace on dashboard.chloejs.org, which needs nothing open on this box" },
    { key: "here", what: "the dashboard on this box, at 127.0.0.1:3067" },
    { key: "later", what: "neither for now: it serves a plain page of its own either way" },
  ]);

  if (where === "cloud") {
    console.log("\nMake a workspace at https://dashboard.chloejs.org and paste the key it shows you once.");
    console.log("It connects out and stays connected, so there is no port to open and no name to point anywhere.");
    const key = (await askHidden("Paste the workspace key (or Enter to do it later): ")).trim();
    if (key) {
      putInEnv("CHLOE_CLOUD_API_KEY", key);
      written(".env", "CHLOE_CLOUD_API_KEY, mode 600");
    }
    return;
  }

  if (where === "here" && !existsSync(join(HERE, "node_modules/@chloejs/ui"))) {
    console.log("\n@chloejs/ui is the dashboard. The runtime serves a plain page without it.");
    if (await yes("Run npm install @chloejs/ui? (Y/n)", true)) {
      spawnSync("npm", ["install", "@chloejs/ui"], { cwd: HERE, stdio: "inherit" });
    }
  }
}

/**
 * The one password. Asked whichever way they watch it, because `npx chloe agent`
 * signs itself in with the account as well, and a dashboard somewhere else has
 * its own sign-in and not this one.
 */
async function thePassword(): Promise<void> {
  const { hasAccount } = await import("#chloe/serve/login");
  if (hasAccount()) return void console.log("\nThis copy already has a password. npx chloe account sets a new one.");

  console.log("\nThe one password. It is what the page on this box asks for, and what npx chloe agent signs in with.");
  await setPassword();
  written("data/", "the account, and the run history");
}

function sayWhatNext(name: string, model: string): void {
  if (wrote.length) console.log(`\nWritten:\n${columns(wrote)}`);
  console.log(
    `\nTry these:\n${columns([
      ["npx chloe", "the server: every cron line, the page, the API"],
      [`npx chloe agent ${name}`, "talk to it in this terminal"],
      ...(model ? ([[`npx chloe agent ${name} summary`, "run the prompt job now"]] as [string, string][]) : []),
      ["npx chloe install", "keep it running after you close this terminal"],
    ])}`,
  );
  console.log("\nWhat to write next, and every setting there is: https://chloejs.org/docs/start");
}

/**
 * Takes these names out of .env beside chloe.config.ts, if they are there.
 */
function dropFromEnv(names: string[]): void {
  const path = join(HERE, ".env");
  if (!existsSync(path)) return;
  const held = readFileSync(path, "utf8").split("\n");
  const kept = held.filter((line) => !names.some((name) => line.trim().startsWith(`${name}=`)));
  if (kept.length === held.length) return;
  writeFileSync(path, kept.join("\n"));
  written(".env", `${names.filter((name) => held.some((line) => line.trim().startsWith(`${name}=`))).join(", ")} taken out, now in chloe.config.ts`);
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
