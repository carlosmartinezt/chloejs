// Self improvement: what the agent is told, which of its own files it may
// write, and writing them as one commit that loads or is put back.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { about, is } from "#chloe/ops/check";
import { agentFor, answers, codeJob, lastAsked } from "#chloe/ops/test/shared";

{
  about("what an agent that may change itself is told");
  const { turn } = await import("#chloe/core/turn");
  const fake = (description: string) => tool({ description, inputSchema: z.object({}), execute: async () => description });
  const tools = {
    selfWriteFile: Object.assign(fake("Change a file."), { own: true, changesAgent: true }),
    memoryEditFile: Object.assign(fake("Change a note."), { own: true }),
  };
  const agent = { ...agentFor(codeJob("unused", async () => ({}))), tools };
  const told = () => lastAsked.find((m) => m.role === "system")?.content ?? "";

  answers.push("No.");
  await turn({ agent: { ...agent, abilities: { selfImprovement: false } }, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is(
    "an agent with selfImprovement off is not told about changing itself",
    [told().includes("## Changing yourself"), told().includes("## How you grow")],
    [false, false],
  );
  answers.push("No.");
  await turn({ agent, prompt: "improve yourself", source: "schedule", job: "nightly" });
  is(
    "an agent that may change itself is told in a turn that cannot who can ask, and to keep the lesson",
    told().includes("## Changing yourself (from the self-improvement plugin)") && told().includes("Keep what you learned in your memory"),
    true,
  );
  is("and that what it cannot do is not yet, and repeated work can be a habit", told().includes("cannot do it yet") && told().includes("make it a habit"), true);
  is("and every section it is told says who put it there", told().includes("## How you grow (from the self-improvement plugin)"), true);
  answers.push("Done.");
  await turn({ agent, prompt: "change it", source: "test", mayChangeAgent: true });
  is("and not in a turn that can", told().includes("## Changing yourself"), false);
}

{
  about("which of its own files an agent may write, and writing them");
  const { jobsOf, markdownJob } = await import("#chloe/load/load");
  const { whyNot, changeOwnFiles } = await import("./changeService.ts");

  const identity = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const before = identity.map((key) => process.env[key]);
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "a person";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "person@example.com";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const failed = (error: Error) => error.message;

  const repo = realpathSync(await mkdtemp(join(tmpdir(), "chloe-self-")));
  const folder = join(repo, "agents", "keeper");
  const memory = join(repo, "memory", "keeper");
  await mkdir(join(folder, "jobs"), { recursive: true });
  await mkdir(join(folder, "skills"), { recursive: true });
  await mkdir(memory, { recursive: true });
  await writeFile(join(folder, "purpose.md"), "Be brief.");
  await writeFile(join(folder, "skills", "deploys.md"), "---\nname: deploys\ndescription: how\n---\nDo it.");
  await writeFile(join(folder, "jobs", "weekly.md"), "---\ncron: 0 8 * * 1\n---\nLook back.");
  await writeFile(join(repo, ".gitignore"), "memory\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the agent as a person wrote it");
  await writeFile(join(repo, "half-done.ts"), "work in progress");

  const home = { id: "keeper", folder, memory: { folder: memory } };
  const may = (path: string) => whyNot(home, path) ?? "yes";
  is("it may change its purpose", may("purpose.md"), "yes");
  is("and a skill", may("skills/deploys.md"), "yes");
  is("and its code", [may("jobs/build.ts"), may("tools/check.ts"), may("agent.ts")], ["yes", "yes", "yes"]);
  is(
    "but not an ending that is neither text nor code",
    may("notes.exe"),
    "only files ending in .md, .txt, .html, .json, .yml, .yaml, .csv, .ts, .js, .mjs, .py, .sh can be written",
  );
  is(
    "nor its memory, which has tools of its own, when somebody keeps that inside its folder",
    whyNot({ ...home, memory: { folder: join(folder, "memory") } }, "memory/STATUS.md") ?? "yes",
    "that is your memory, which you change with memoryEditFile",
  );
  is("nor what marks its runs", may("evals/status.json"), "evals/ is how your runs are marked");
  is("and a skill that is a folder", may("skills/deploys/SKILL.md"), "yes");
  is("and what that skill keeps beside it", [may("skills/deploys/hosts.json"), may("skills/deploys/deploy.sh")], ["yes", "yes"]);
  is(
    "nor a skill that is not markdown",
    may("skills/deploys.txt"),
    "a skill is skills/<name>.md, or a folder skills/<name>/ with a SKILL.md in it",
  );
  is("nor anything outside its folder", await Promise.resolve().then(() => may("../other/x.md")).catch(failed), `Path is outside ${folder}: ../other/x.md`);

  const wrote = (path: string, content: string, message = "a change worth making") =>
    changeOwnFiles(home, [{ path, content }], message).then((done) => done.commit ?? "not committed", failed);
  is(
    "a job that would not load is refused",
    await wrote("jobs/weekly.md", "---\ncron: every monday\n---\nLook back."),
    'jobs/weekly.md would not load as a job: its cron line does not read: A cron line needs five fields, got 2: "every monday".',
  );
  is(
    "so is a setting no job reads",
    await wrote("jobs/weekly.md", "---\nretries: 3\n---\nLook back."),
    "jobs/weekly.md would not load as a job: it has retries at the top, and a job only reads cron, description, timezone, model.",
  );
  is(
    "and a job made to run more than once an hour",
    await wrote("jobs/weekly.md", "---\ncron: */5 * * * *\n---\nLook back."),
    'A job you write runs at most once an hour: give its cron line one minute, like "0 7 * * *".',
  );
  is("and JSON that does not parse", (await wrote("targets.json", "{ nope")).startsWith("targets.json is not valid JSON"), true);
  is("and a file with nothing in it", await wrote("purpose.md", "  \n"), "purpose.md would be empty. Write what it should say.");
  const made = await wrote("jobs/weekly.md", "---\ncron: 0 9 * * 1\ntimezone: America/New_York\n---\nLook back at the week.");
  is("a job that loads is written and committed", /^[0-9a-f]{12}$/.test(made), true);
  is("under the agent's id, with its message", git(repo, "log", "-1", "--format=%an: %s"), "keeper: a change worth making");
  is("and nothing of anybody else's went with it", git(repo, "status", "--porcelain"), "?? half-done.ts");
  is(
    "and it is a job once agent.ts names it",
    (await jobsOf("keeper", folder, [markdownJob("jobs/weekly.md")])).map((one) => [one.id, one.cron]),
    [["weekly", "0 9 * * 1"]],
  );
  await writeFile(join(folder, "purpose.md"), "Be brief, and say so.");
  await wrote("purpose.md", "Be long.");
  is(
    "what somebody changed by hand is committed first, under their name, and the agent's change after it",
    git(repo, "log", "-2", "--format=%an: %s", "--", "agents/keeper/purpose.md").split("\n"),
    ["keeper: a change worth making", "a person: Changed by hand, before keeper changed it"],
  );
  is("so going back one change gives the hand's version", git(repo, "show", "HEAD~1:agents/keeper/purpose.md"), "Be brief, and say so.");
  is("and the change is the agent's purpose now", await readFile(join(folder, "purpose.md"), "utf8"), "Be long.");

  identity.forEach((key, i) => {
    if (before[i] === undefined) delete process.env[key];
    else process.env[key] = before[i];
  });
}

{
  about("an agent changes its own code, and nothing that does not load is kept");
  const { execFileSync } = await import("node:child_process");
  const { existsSync, realpathSync, statSync } = await import("node:fs");
  const { rm, symlink } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { loadAgain, checksDone } = await import("#chloe/load/load");
  const { whyNot, changeOwnFiles } = await import("./changeService.ts");

  // Outside the runtime's folder, whose files are never imported afresh, with
  // the package linked in the way a project installs it. A repository of its own.
  const folder = realpathSync(await mkdtemp(join(tmpdir(), "coder-")));
  await mkdir(join(folder, "node_modules/@chloejs"), { recursive: true });
  await symlink(fileURLToPath(new URL("../..", import.meta.url)), join(folder, "node_modules/@chloejs/core"));
  await writeFile(join(folder, ".gitignore"), "node_modules\n");
  const memory = await mkdtemp(join(tmpdir(), "coder-memory-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "a person", GIT_AUTHOR_EMAIL: "p@example.com", GIT_COMMITTER_NAME: "a person", GIT_COMMITTER_EMAIL: "p@example.com" } }).trim();
  const definition = (jobs: string, imports = "") =>
    `import { defineAgent } from "@chloejs/core";\n${imports}\nexport default defineAgent({ id: "coder", identity: "", ` +
    `purpose: "Be brief.", model: "anthropic/claude-haiku-4.5", memory: { folder: ${JSON.stringify(memory)} }, jobs: [${jobs}] });\n`;
  await writeFile(join(folder, "agent.ts"), definition(""));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "the agent as a person wrote it");

  const home = { id: "coder", folder, memory: { folder: memory } };
  is("and a job's code may sit in a folder of its own", whyNot(home, "jobs/lib/feeds.ts"), undefined);
  is("but never its evals", whyNot(home, "evals/hello.json"), "evals/ is how your runs are marked");

  const wrote = (path: string, content: string) =>
    changeOwnFiles(home, [{ path, content }], "a change worth making").then((done) => done.commit ?? "not committed", (error: Error) => error.message);
  const job = (cron: string) =>
    `import { defineJob } from "@chloejs/core";\nexport default defineJob({ id: "hello", description: "Says hello.", cron: "${cron}", run: async () => "Hello." });\n`;

  const kept = (said: string) => (/^[0-9a-f]{12}$/.test(said) ? "a commit" : said);
  is("a new job's file is kept", kept(await wrote("jobs/hello.ts", job("0 7 * * *"))), "a commit");
  is("and naming it in agent.ts is kept too", kept(await wrote("agent.ts", definition("hello", 'import hello from "./jobs/hello.ts";'))), "a commit");
  is("so the agent has that job", (await loadAgain(home)).jobs.map((one) => one.id), ["hello"]);
  is("each a commit under its name", git("log", "--format=%an", "-2"), "coder\ncoder");
  is("a script it writes in a skill's folder is a commit", kept(await wrote("skills/greet/hi.sh", "#!/bin/sh\necho hi\n")), "a commit");
  is("and executable, so it can run", (statSync(join(folder, "skills/greet/hi.sh")).mode & 0o111) !== 0, true);

  const broken = definition("hello, missing", 'import hello from "./jobs/hello.ts";\nimport missing from "./jobs/missing.ts";');
  const refused = await wrote("agent.ts", broken);
  is("an agent.ts that would not load is refused, saying why", refused.startsWith("agent.ts is put back as it was, because you would not load:"), true);
  is("and put back as it was", (await readFile(join(folder, "agent.ts"), "utf8")).includes("missing"), false);
  is("with nothing committed and nothing left changed", [git("log", "--format=%an", "-1"), git("status", "--porcelain")], ["coder", ""]);

  is(
    "a job made to run more than once an hour is put back",
    await wrote("jobs/hello.ts", job("*/5 * * * *")),
    'jobs/hello.ts is put back as it was, because hello would run more than once an hour, and a job you write runs at most once an hour: give its cron line one minute, like "0 7 * * *"',
  );
  is("as it was", (await readFile(join(folder, "jobs/hello.ts"), "utf8")).includes("0 7 * * *"), true);
  const thrown = await wrote("jobs/throws.ts", 'throw new Error("not like this");\n');
  is("a new file nothing imports yet is kept, since it does not change how the agent loads", kept(thrown), "a commit");
  is(
    "but naming it is refused when importing it throws",
    (await wrote("agent.ts", definition("hello", 'import hello from "./jobs/hello.ts";\nimport "./jobs/throws.ts";'))).includes("not like this"),
    true,
  );

  // A change that only loads with two files changed together.
  const together = (files: { path: string; content: string }[]) =>
    changeOwnFiles(home, files, "hello reads its words from a file of its own").then((done) => done.commit, (error: Error) => error.message);
  const greetingFile = { path: "jobs/lib/words.ts", content: 'export const greeting = "Hello again.";\n' };
  const using = {
    path: "jobs/hello.ts",
    content: 'import { defineJob } from "@chloejs/core";\nimport { greeting } from "./lib/words.ts";\nexport default defineJob({ id: "hello", description: "Says hello.", cron: "0 7 * * *", run: async () => greeting });\n',
  };
  is("a job that imports a file not there yet is put back on its own", (await together([using])).startsWith("jobs/hello.ts is put back as it was, because you would not load"), true);
  is("given with that file, both are kept", kept(await together([greetingFile, using])), "a commit");
  is("as one commit", git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["jobs/hello.ts", "jobs/lib/words.ts"]);
  const failing = await together([{ path: "jobs/lib/more.ts", content: "export const more = 1;\n" }, { ...using, content: "this is not code" }]);
  is("when they would not load, every one is put back", [failing.startsWith("jobs/lib/more.ts, jobs/hello.ts are put back as they were"), existsSync(join(folder, "jobs/lib/more.ts")), (await readFile(join(folder, "jobs/hello.ts"), "utf8")).includes("greeting")], [true, false, true]);
  is("and the same file twice is refused before anything is written", await together([greetingFile, greetingFile]), "jobs/lib/words.ts is in the list twice. Write each file once.");

  await checksDone();
  is("and a reload waits for none once they are done", existsSync(join(folder, "jobs/hello.ts")), true);

  await rm(folder, { recursive: true, force: true });
  await rm(memory, { recursive: true, force: true });
}
