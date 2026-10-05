// An agent's notes: the memory tools, its folders, and its history in git.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, failed, is } from "#chloe/ops/check";
import type { Agent } from "./shared.ts";
import { agentFor, answers, codeJob, lastAsked, row, work } from "./shared.ts";

{
  about("adding to the end of a note");

  const { writeFiles } = await import("@chloejs/core/services");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const folder = await mkdtemp(`${(await import("node:os")).tmpdir()}/chloe-append-`);
  await writeFiles(folder, "LESSONS.md", "# Lessons\n\n- one");
  await writeFiles(folder, "LESSONS.md", "- two\n", { append: true });
  is("what was there stays, and the new part starts on a line of its own", await readFile(`${folder}/LESSONS.md`, "utf8"), "# Lessons\n\n- one\n- two\n");
  await writeFiles(folder, "new/list.md", "- first\n", { append: true });
  is("adding to a file that is not there yet makes it", await readFile(`${folder}/new/list.md`, "utf8"), "- first\n");
}

{
  about("reading part of a note");

  const { readFiles } = await import("@chloejs/core/services");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const folder = await mkdtemp(`${(await import("node:os")).tmpdir()}/chloe-read-`);
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  await writeFile(`${folder}/log.html`, text);
  is("with nothing asked, the whole file comes back as it always did", (await readFiles(folder, "log.html")).content, text);
  const part = await readFiles(folder, "log.html", { from: 40, lines: 3 });
  is("a range comes back as those lines", [part.content, part.from, part.to, part.totalLines], ["line 40\nline 41\nline 42", 40, 42, 100]);
  is("and says how to read the rest", part.note?.startsWith("This is lines 40 to 42 of 100."), true);
  const cut = await readFiles(folder, "log.html", { limit: 30 });
  is("a file over the limit is cut at the last whole line that fits", cut.content, "line 1\nline 2\nline 3\nline 4");
  is("and says how long it is", cut.totalLines, 100);
  is("a file under the limit comes back whole, with no note", (await readFiles(folder, "log.html", { limit: 10_000 })).content, text);
  is("from on its own reads to the end", (await readFiles(folder, "log.html", { from: 99 })).content, "line 99\nline 100");
  is("a start past the end says how long the file is", (await readFiles(folder, "log.html", { from: 500 })).note, "The file has only 100 lines.");
  await writeFile(`${folder}/one-line.html`, "x".repeat(1000));
  is("a file that is one long line is still cut at the limit", (await readFiles(folder, "one-line.html", { limit: 30 })).content.length, 30);
}

{
  about("searching notes, with the lines around each match");

  const { searchFiles } = await import("@chloejs/core/services");
  const { mkdtemp, mkdir: makeDir, writeFile } = await import("node:fs/promises");
  const folder = await mkdtemp(`${(await import("node:os")).tmpdir()}/chloe-search-`);
  await makeDir(`${folder}/work`);
  await makeDir(`${folder}/secrets`);
  const page = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`);
  page[9] = "Mercor: waiting";
  page[11] = "Mercor: second call";
  await writeFile(`${folder}/work/index.html`, page.join("\n"));
  await writeFile(`${folder}/secrets/keys.txt`, "mercor key");
  const plain = await searchFiles(folder, "mercor");
  is("a plain search gives paths as the other tools take them", plain.results, ["work/index.html:10:Mercor: waiting", "work/index.html:12:Mercor: second call"]);
  is("and never looks into a folder no tool may open", plain.matches, 2);
  const near = await searchFiles(folder, "mercor", undefined, { around: 2 });
  is(
    "matches close together share one block, with the matching lines marked",
    near.results,
    ["work/index.html:8-14\n  8| row 8\n  9| row 9\n> 10| Mercor: waiting\n  11| row 11\n> 12| Mercor: second call\n  13| row 13\n  14| row 14"],
  );
  await writeFile(`${folder}/work/long.html`, `start\n${"x".repeat(1000)} mercor\nend`);
  const long = await searchFiles(folder, "mercor", "work/long.html", { around: 1 });
  is("a very long line is cut", long.results[0].split("\n")[2].length < 320, true);
  await writeFile(`${folder}/work/costs.txt`, "card fee (3.5%)\ncard fee 345");
  is("the text is matched as written, not as a pattern", (await searchFiles(folder, "(3.5%)")).results, ["work/costs.txt:1:card fee (3.5%)"]);
  await writeFile(`${folder}/work/photo.jpg`, Buffer.from([0xff, 0xd8, 0, 0x6d, 0x65, 0x72, 0x63, 0x6f, 0x72]));
  is("and a file that is not text is not searched", (await searchFiles(folder, "mercor", "work/photo.jpg")).matches, 0);
}

{
  about("changing one part of a note");

  const { editFiles } = await import("@chloejs/core/services");
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const folder = await mkdtemp(`${(await import("node:os")).tmpdir()}/chloe-edit-`);
  await writeFile(`${folder}/work.html`, "<h1>Work</h1>\n<li>Mercor: waiting</li>\n<li>Snap: no</li>\n<li>Clay: no</li>\n");
  const done = await editFiles(folder, "work.html", "Mercor: waiting", "Mercor: rejected 1 Oct");
  is(
    "the text is replaced and the rest of the file is left as it was",
    await readFile(`${folder}/work.html`, "utf8"),
    "<h1>Work</h1>\n<li>Mercor: rejected 1 Oct</li>\n<li>Snap: no</li>\n<li>Clay: no</li>\n",
  );
  is("it says which line the change is on", done.line, 2);
  const why = (p: Promise<unknown>) => p.then(() => "not refused", (e: Error) => e.message);
  is("text that is not there is refused", (await why(editFiles(folder, "work.html", "Amazon", "x"))).startsWith("That text is not in the file"), true);
  is("text that is there twice is refused, saying how many", await why(editFiles(folder, "work.html", ": no", "x")), "That text is in the file 2 times. Include more of the lines around it so it is found once.");
  is("and neither refusal changed the file", (await readFile(`${folder}/work.html`, "utf8")).includes("Snap: no"), true);
  await editFiles(folder, "work.html", "<li>Clay: no</li>\n", "");
  is("an empty replacement deletes the text", (await readFile(`${folder}/work.html`, "utf8")).includes("Clay"), false);
  is("a file that is not there is refused", (await why(editFiles(folder, "gone.html", "a", "b"))).includes("ENOENT"), true);
  is("and the edge of the folder holds", (await why(editFiles(folder, "../outside.html", "a", "b"))) === "not refused", false);
}

{
  about("the folders of a memory, before the first call");

  const { folderTree } = await import("@chloejs/core/services");
  const { memoryTools } = await import("#chloe/model/tools/memory");
  const { turn } = await import("#chloe/core/turn");
  const { mkdir: makeDir, mkdtemp, writeFile } = await import("node:fs/promises");
  const folder = await mkdtemp(`${(await import("node:os")).tmpdir()}/chloe-tree-`);
  for (const path of ["02_areas/me/reading/old", "02_areas/money", "01_projects/tennis", ".git/objects", "secrets"]) {
    await makeDir(`${folder}/${path}`, { recursive: true });
  }
  await writeFile(`${folder}/02_areas/index.html`, "<h1>Areas</h1>");
  is(
    "two levels of folders, without files, hidden folders or the ones no tool may open",
    await folderTree(folder),
    ["01_projects/", "  tennis/", "02_areas/", "  me/", "  money/"],
  );
  is("a long tree stops and says so", await folderTree(folder, { most: 2 }), ["01_projects/", "  tennis/", "(more folders, left out)"]);
  is("an empty folder has none", await folderTree(`${folder}/01_projects/tennis`), []);

  const keeper = { ...agentFor(codeJob("none", async () => "")), tools: memoryTools()({ id: "test", memory: { folder } }) };
  answers.push("Noted.");
  await turn({ agent: keeper, prompt: "where are my reading notes?", source: "test" });
  const opening = lastAsked[0]?.content ?? "";
  is("a turn starts with them, from the memory tools' overview", opening.includes("## The folders in your memory") && opening.includes("02_areas/\n  me/"), true);
  answers.push("Noted.");
  await turn({ agent: keeper, prompt: "and now?", source: "test", without: ["memoryListFiles"] });
  is("and without the tool, without them", lastAsked[0]?.content.includes("The folders in your memory"), false);
}

{
  about("an agent's history, in git");

  const { execFileSync } = await import("node:child_process");
  const { chmod, mkdtemp, mkdir: makeDir, readFile: get, writeFile: put } = await import("node:fs/promises");
  const { realpathSync } = await import("node:fs");
  const { jobsOf, loadAll, markdownJob } = await import("#chloe/load/load");
  const { setAgentDirs } = await import("#chloe/core/paths");
  const { change, makeRepo, markSeen, undo } = await import("#chloe/services/historyService");
  const { whyNot, writeOwn } = await import("#chloe/services/ownFilesService");
  const { runScripts } = await import("#chloe/services/scriptsService");
  const { agentChanges } = await import("#chloe/serve/changes");
  const { open, tree } = await import("#chloe/serve/files");

  // What this box's git calls a person, for the commits a person makes.
  const identity = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const before = identity.map((key) => process.env[key]);
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "a person";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "person@example.com";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const failed = (error: Error) => error.message;

  // The repo the agents are written in, with somebody's work in progress in it.
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "chloe-history-")));
  const folder = join(repo, "agents", "keeper");
  await makeDir(join(folder, "jobs"), { recursive: true });
  await makeDir(join(folder, "skills"), { recursive: true });
  await put(join(folder, "instructions.md"), "Be brief.");
  await put(join(folder, "PERMISSIONS.md"), "| deploy | no |");
  await put(join(folder, "skills", "deploys.md"), "---\nname: deploys\ndescription: how\n---\nDo it.");
  await put(join(folder, "jobs", "build.ts"), "// a job made of code");
  await put(join(folder, "jobs", "build.md"), "The words of that job.");
  await put(join(folder, "jobs", "weekly.md"), "---\ncron: 0 8 * * 1\n---\nLook back.");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the agent as a person wrote it");
  await put(join(repo, "half-done.ts"), "work in progress");

  // The memories start keeping history as the agents load: one repository,
  // beside the agents rather than inside any of their folders, a folder each.
  const memories = join(repo, "memory");
  const memory = join(memories, "keeper");
  const theirs = join(memories, "other");
  await makeDir(memory, { recursive: true });
  await makeDir(theirs, { recursive: true });
  await put(join(memory, "STATUS.md"), "old news");
  await makeRepo(memories, "keeper");
  is("the memories are one repository of their own", git(memory, "rev-parse", "--show-toplevel"), memories);
  is(
    "holding what was already there, under the agent's id",
    git(memories, "log", "--format=%an: %s"),
    "keeper: What was here when this folder started keeping its history",
  );
  is("and the repository around them leaves them alone", git(repo, "status", "--porcelain"), "?? half-done.ts");

  // Somebody changes it by hand, then a run changes it.
  await put(join(memory, "notes.md"), "written by hand");
  const status = codeJob(
    "status",
    async ({ step, memory: at }) => step("write", () => put(join(at, "STATUS.md"), "new news").then(() => "done")),
    undefined,
    () => "wrote the status",
  );
  const keeper: Agent = { ...agentFor(status), id: "keeper", folder, memory: { folder: memory, commit: "each run" } };
  const ran = await work({ agent: keeper, job: status });
  is(
    "a change made outside a run is committed before it, under this box's git name",
    git(memory, "log", "-1", "--skip=1", "--format=%an: %s"),
    "a person: Changed outside a run",
  );
  is(
    "and what the run changed is committed after it, under the agent's id",
    git(memory, "log", "-1", "--format=%an <%ae>: %s"),
    "keeper <>: status: wrote the status",
  );
  is("ending with the run it came from", git(memory, "log", "-1", "--format=%b"), `Run: ${ran.runId}`);
  is(
    "which lists it",
    JSON.parse(row(ran.runId).commits).map((one: { in: string; subject: string }) => [one.in, one.subject]),
    [["memory", "status: wrote the status"]],
  );
  const quiet = await work({ agent: keeper, job: codeJob("nothing", async () => "ok") });
  is("a run that changed nothing makes no commit", row(quiet.runId).commits, null);

  // The folder beside it is another agent's memory, in the same repository.
  await put(join(theirs, "journal.md"), "nobody has committed this");
  await work({ agent: keeper, job: status });
  is(
    "a run commits its own memory and leaves the one beside it alone",
    git(memories, "status", "--porcelain", "-uall"),
    "?? other/journal.md",
  );

  // What it may change of its own folder.
  const home = { id: "keeper", folder, memory: { folder: memory } };
  const rules = { files: ["md", "txt", "json"], except: ["PERMISSIONS.md"] };
  const may = (path: string) => whyNot(home, rules, path) ?? "yes";
  is("it may change its instructions", may("instructions.md"), "yes");
  is("and a skill", may("skills/deploys.md"), "yes");
  is("but not what is kept back for a person", may("PERMISSIONS.md"), "it is kept back for a person to change");
  is("nor anything in a folder of code", may("tools/check.md"), "tools/ is code");
  is("nor a file of code", may("jobs/build.ts"), "it is code");
  is("nor an ending it was not given", may("notes.html"), "only files ending in .md, .txt, .json can be written");
  is(
    "nor its memory, which has tools of its own, when somebody keeps that inside its folder",
    whyNot({ ...home, memory: { folder: join(folder, "memory") } }, rules, "memory/STATUS.md") ?? "yes",
    "that is your memory, which you write with memoryWriteFile",
  );
  is("nor what marks its runs", may("evals/status.json"), "evals/ is how your runs are marked");
  is("nor a file no loader would read", may("skills/deploys/SKILL.md"), "a file in a folder inside skills/ is never read");
  is(
    "nor a skill that is not markdown",
    may("skills/deploys.txt"),
    "a skill is one markdown file, and anything else in skills/ is never read",
  );
  is("nor anything outside its folder", await Promise.resolve().then(() => may("../other/x.md")).catch(failed), `Path is outside ${folder}: ../other/x.md`);

  const wrote = (path: string, content: string, message = "a change worth making") =>
    writeOwn(home, rules, path, content, message).then((done) => done.commit ?? "not committed", failed);
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
  is("and a file with nothing in it", await wrote("instructions.md", "  \n"), "instructions.md would be empty. Write what it should say.");
  const made = await wrote("jobs/weekly.md", "---\ncron: 0 9 * * 1\ntimezone: America/New_York\n---\nLook back at the week.");
  is("a job that loads is written and committed", /^[0-9a-f]{12}$/.test(made), true);
  is("under the agent's id, with its message", git(repo, "log", "-1", "--format=%an: %s"), "keeper: a change worth making");
  is("and nothing of anybody else's went with it", git(repo, "status", "--porcelain"), "?? half-done.ts");
  is(
    "writing it does not make it a job, because jobs are named in agent.ts",
    (await jobsOf("keeper", folder, [])).map((one) => one.id),
    [],
  );
  is(
    "naming it makes it one, and the words of a job made of code are not a job",
    (await jobsOf("keeper", folder, [markdownJob("jobs/weekly.md")])).map((one) => [one.id, one.cron]),
    [["weekly", "0 9 * * 1"]],
  );
  is(
    "and a job that is not there yet is refused, because only a person can name it",
    await wrote("jobs/monthly.md", "---\ncron: 0 9 1 * *\n---\nLook back further."),
    "jobs/monthly.md would be a new job, and a job only runs once it is named in agent.ts, which only a person can change. " +
      "Ask for it, and change a job that is already there meanwhile.",
  );
  await put(join(folder, "instructions.md"), "Be brief, and say so.");
  is(
    "a file somebody is in the middle of changing is left alone",
    await wrote("instructions.md", "Be long."),
    "instructions.md has changes nobody has committed yet, and writing it would put them under your name. " +
      "Leave it for now, and say that you could not change it and why.",
  );
  git(repo, "checkout", "-q", "--", "agents/keeper/instructions.md");

  // A change made during a run belongs to that run.
  const improve = codeJob("improve", async ({ step }) =>
    step("rewrite the skill", () =>
      writeOwn(home, rules, "skills/deploys.md", "---\nname: deploys\ndescription: how\n---\nShip it small.", "the skill says how to ship"),
    ).then(() => "ok"),
  );
  const improved = await work({ agent: keeper, job: improve });
  is(
    "a change made during a run is listed on that run",
    JSON.parse(row(improved.runId).commits).map((one: { in: string; subject: string }) => [one.in, one.subject]),
    [["folder", "the skill says how to ship"]],
  );
  is("and says which run it came from", git(repo, "log", "-1", "--format=%b"), `Run: ${improved.runId}`);

  // The site's view of it.
  const all = await agentChanges(keeper, {}, "test");
  is(
    "both places are listed",
    all.changes.map((one) => `${one.in} ${one.by}: ${one.subject}`).sort(),
    [
      "folder a person: the agent as a person wrote it",
      "folder keeper: a change worth making",
      "folder keeper: the skill says how to ship",
      "memory a person: Changed outside a run",
      "memory keeper: What was here when this folder started keeping its history",
      "memory keeper: status: wrote the status",
    ],
  );
  is("what the agent did is new until somebody looks", all.unseen, 4);
  markSeen("keeper");
  is("and then it is not", (await agentChanges(keeper, {}, "test")).unseen, 0);
  const history = (await agentChanges(keeper, { place: "memory", path: "STATUS.md" }, "test")).changes;
  is(
    "one file's history is the commits that touched it, newest first",
    history.map((one) => one.subject),
    ["status: wrote the status", "What was here when this folder started keeping its history"],
  );
  const skill = all.changes.find((one) => one.subject === "the skill says how to ship")!;
  const shown = await change(keeper, "folder", skill.id);
  is(
    "one change comes with its diff, and its paths as the agent's folder sees them",
    [shown?.files, shown?.diff.includes("+Ship it small.")],
    [[{ path: "skills/deploys.md", status: "M" }], true],
  );
  const undone = await undo(keeper, "folder", skill.id);
  is("undoing it puts the file back", await get(join(folder, "skills", "deploys.md"), "utf8"), "---\nname: deploys\ndescription: how\n---\nDo it.");
  is("and commits that under this box's git name", git(repo, "log", "-1", "--format=%an: %s"), 'a person: Undo "the skill says how to ship"');
  is("saying which files", undone.files, ["skills/deploys.md"]);
  await work({
    agent: keeper,
    job: codeJob("again", async ({ step, memory: at }) => step("write", () => put(join(at, "STATUS.md"), "newer news").then(() => "done"))),
  });
  is(
    "a change to a file that has changed since cannot be undone",
    await undo(keeper, "memory", history[0].id).then(() => "undone", failed),
    "STATUS.md has changed since, so undoing this would lose that change. Undo the later change first.",
  );
  is(
    "nor can the first commit",
    await undo(keeper, "memory", history[1].id).then(() => "undone", failed),
    "This is the first commit there is, so there is nothing before it to go back to.",
  );

  // Seen from the site and from its scripts.
  await makeDir(join(folder, "scripts"), { recursive: true });
  await put(join(folder, "scripts", "where.sh"), '#!/bin/sh\nprintf %s "$MEMORY_FOLDER"\n');
  await chmod(join(folder, "scripts", "where.sh"), 0o755);
  setAgentDirs(new Map([["keeper", folder]]), new Map([["keeper", memory]]));
  is(
    "the site's view of an agent's folder leaves its memory out",
    (await tree("keeper")).map((one) => one.name),
    ["jobs", "scripts", "skills", "instructions.md", "PERMISSIONS.md"],
  );
  is("and will not open a file in it", await open("keeper", "memory/STATUS.md"), null);
  is("a script is told where its agent's memory is", (await runScripts("keeper", "where.sh")).stdout, memory);
  await loadAll();

  identity.forEach((key, i) => {
    if (before[i] === undefined) delete process.env[key];
    else process.env[key] = before[i];
  });
}
