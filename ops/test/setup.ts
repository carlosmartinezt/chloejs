// The files npx chloe setup writes.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { about, is } from "#chloe/ops/check";
import { work } from "./shared.ts";

{
  about("the files npx chloe setup writes");

  const { identifier, modelLine, idProblem, STARTER_MODEL_LINE, starterFiles, withChannel, withSetting } = await import("#chloe/ops/starter");
  const { resolveAgent, jobsOf, markdownJob } = await import("#chloe/load/load");
  const { ROOT, settings } = await import("@chloejs/core");


  const { findConfig } = await import("#chloe/core/find");
  is("the project is found by walking up", findConfig(join(ROOT, "ops")), ROOT);
  is("and nowhere above the root of the disk has one", findConfig("/"), "");

  is("a name with a dash imports as one word", identifier("night-watch"), "nightWatch");
  is("a plain id is fine", idProblem("watcher"), "");
  is("an id with a capital in it is not", idProblem("Watcher").startsWith("An id is lower case"), true);
  is("and neither is one that starts with a digit", idProblem("2fast").startsWith("An id is lower case"), true);

  const files = starterFiles("watcher");
  const config = files.find((one) => one.path === "chloe.config.ts")!.body;
  is("chloe.config.ts names the agent it wrote", config.includes('from "./agents/watcher/agent.ts"'), true);
  is("and lists it, because an agent not on the list does not exist", config.includes("agents: [watcher]"), true);
  is("it has the line setup puts the chosen model in", config.includes(STARTER_MODEL_LINE), true);
  is(
    "and the model goes in as a setting, with preferredRoute as a list",
    modelLine({ defaultModel: "anthropic/claude-sonnet-5", preferredRoute: "gateway,claude" }),
    'model: { defaultModel: "anthropic/claude-sonnet-5", preferredRoute: ["gateway","claude"] },',
  );
  is(
    "and the key is named where it is read from, never written in",
    modelLine({ defaultModel: "openrouter/free" }, "CHLOE_MODEL_KEY"),
    'model: { defaultModel: "openrouter/free", key: process.env.CHLOE_MODEL_KEY },',
  );
  const keyLine = "dashboard: { remote: { api_key: process.env.CHLOE_DASHBOARD_REMOTE_API_KEY } },";
  const withKey = withSetting(config, keyLine);
  is("a key's line goes into the settings setup wrote", withKey?.includes(`  settings: {\n    ${keyLine}\n`), true);
  is("and not twice", withSetting(withKey!, keyLine), null);
  is("nor into a config that already says dashboard", withSetting(withKey!, "dashboard: { local: \"builtin\" },"), null);

  // Written inside the repo rather than in tmp, because the agent.ts it writes
  // imports "@chloejs/core" and a package can only import itself from inside
  // itself. This is the case that catches a renamed export: the starter is text
  // here, so nothing else typechecks it.
  await mkdir(join(ROOT, "data"), { recursive: true });
  const folder = await mkdtemp(join(ROOT, "data", "starter-"));
  for (const file of files) {
    if (file.add) continue;
    const path = join(folder, file.path.replace("agents/watcher/", ""));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.body);
  }

  const definition = (await import(pathToFileURL(join(folder, "agent.ts")).href)).default;

  // Set here rather than left to the config, because the project this suite runs
  // in may declare one, and both halves of this are about what happens when it
  // does and when it does not.
  const was = settings.model.defaultModel;
  settings.model.defaultModel = "";
  const refused = await resolveAgent(definition).then(() => "", (error: Error) => error.message);
  is("with no model.defaultModel set, an agent that names none is refused", refused.includes("does not say which model"), true);

  // model.defaultModel, which is where the model a new project chose is written down
  // once for every agent.
  settings.model.defaultModel = "anthropic/claude-haiku-4.5";
  const agent = await resolveAgent(definition);
  is("the agent it wrote loads", agent.id, "watcher");
  is("its words come from the file beside it", agent.instructions.startsWith("You are watcher."), true);
  is("it names no model, so it asks the one in settings", definition.model, undefined);
  is("and that is what it loads with", agent.model, settings.model.defaultModel);
  is("it has both kinds of job", agent.jobs.map((one) => one.id), ["daily-note", "summary"]);
  is("the code one has a cron line", agent.jobs[0].cron, "0 8 * * *");
  is("and asks no model", Boolean(agent.jobs[0].run), true);
  is("the prompt one is words", Boolean(agent.jobs[1].prompt), true);
  is("and runs only when somebody starts it", agent.jobs[1].cron, undefined);

  // The job for real, against the same runner the clock uses.
  const [dailyNote] = await jobsOf("watcher", folder, [(await import(pathToFileURL(join(folder, "jobs/daily-note.ts")).href)).default]);
  const ran = await work({ agent: { ...agent, jobs: [dailyNote] }, job: dailyNote, source: "terminal" });
  is("it writes a day and counts them", ran.steps, 3);
  is("and the line is in its memory", (await readFile(join(agent.memory.folder, "days.md"), "utf8")).startsWith("- "), true);

  const summary = await jobsOf("watcher", folder, [markdownJob("jobs/summary.md")]);
  is("the prompt job's description is read from its frontmatter", summary[0].description?.includes("asks a model"), true);

  // The channel setup adds for somebody who says yes to WhatsApp: written into
  // the file it just wrote, and loaded here, so a renamed export fails this.
  const body = files.find((one) => one.path.endsWith("agent.ts"))!.body;
  const added = withChannel(body, 'import { whatsappChannel } from "@chloejs/core/channels";', 'whatsappChannel({ allowFrom: ["+447700900123"] })');
  is("a channel setup adds is imported and listed", [added.includes('from "@chloejs/core/channels"'), added.includes("channels: [whatsappChannel(")], [true, true]);
  is("a file that already says channels is somebody's own, and is left alone", withChannel(added, "x", "y"), "");
  await writeFile(join(folder, "with-channel.ts"), added);
  const onWhatsApp = await resolveAgent((await import(pathToFileURL(join(folder, "with-channel.ts")).href)).default);
  is("and the agent it wrote is on that channel", onWhatsApp.channels.map((one) => one.name), ["whatsapp"]);

  settings.model.defaultModel = was;
  await rm(folder, { recursive: true, force: true });
}
