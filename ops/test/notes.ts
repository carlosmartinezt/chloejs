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
  const done = await editFiles(folder, "work.html", [{ old: "Mercor: waiting", new: "Mercor: rejected 1 Oct" }]);
  is(
    "the text is replaced and the rest of the file is left as it was",
    await readFile(`${folder}/work.html`, "utf8"),
    "<h1>Work</h1>\n<li>Mercor: rejected 1 Oct</li>\n<li>Snap: no</li>\n<li>Clay: no</li>\n",
  );
  is("it says which line the change is on", done.lines, [2]);
  const why = (p: Promise<unknown>) => p.then(() => "not refused", (e: Error) => e.message);
  is("text that is not there is refused", (await why(editFiles(folder, "work.html", [{ old: "Amazon", new: "x" }]))).startsWith("That text is not in the file"), true);
  is("text that is there twice is refused, saying how many", await why(editFiles(folder, "work.html", [{ old: ": no", new: "x" }])), "That text is in the file 2 times. Include more of the lines around it so it is found once.");
  is("and neither refusal changed the file", (await readFile(`${folder}/work.html`, "utf8")).includes("Snap: no"), true);
  await editFiles(folder, "work.html", [{ old: "<li>Clay: no</li>\n", new: "" }]);
  is("an empty replacement deletes the text", (await readFile(`${folder}/work.html`, "utf8")).includes("Clay"), false);
  is("a file that is not there is refused", (await why(editFiles(folder, "gone.html", [{ old: "a", new: "b" }]))).includes("ENOENT"), true);
  await editFiles(folder, "log.md", [{ new: "first line\n" }]);
  await editFiles(folder, "log.md", [{ new: "second line" }]);
  is("with no old text, the file is made, and the next text is added to its end", await readFile(join(folder, "log.md"), "utf8"), "first line\nsecond line");
  is("and nothing to add is refused", await why(editFiles(folder, "log.md", [{ new: "" }])), "There is nothing to add: `new` is empty.");
  is("and the edge of the folder holds", (await why(editFiles(folder, "../outside.html", [{ old: "a", new: "b" }]))) === "not refused", false);

  await writeFile(`${folder}/book.html`, "<section>\n    <p>A long note that\nwraps here</p>\n    <p>Next</p>\n</section>\n");
  await editFiles(folder, "book.html", [{ old: "    <p>A long note that\n    wraps here</p>\n", new: "    <p>A long note that wraps here</p>\n" }]);
  is(
    "text copied with the wrong indent is still found once, and the file keeps its own indent",
    await readFile(`${folder}/book.html`, "utf8"),
    "<section>\n    <p>A long note that wraps here</p>\n    <p>Next</p>\n</section>\n",
  );
  await writeFile(`${folder}/twice.html`, "<li>a</li>\n  <li>a</li>\n");
  is("found twice that way, it is refused, saying how many", await why(editFiles(folder, "twice.html", [{ old: "    <li>a</li>", new: "x" }])), "That text is in the file 2 times. Include more of the lines around it so it is found once.");
  is(
    "text that is not there names the line of it that is missing",
    await why(editFiles(folder, "book.html", [{ old: "<p>Next</p>\n<p>After</p>", new: "x" }])),
    'That text is not in the file: this line of it is not there: "<p>After</p>". Read that part of the file again and copy it, HTML entities included.',
  );
  await writeFile(`${folder}/chapters.html`, "<h2>One</h2>\n<p>a</p>\n<h2>Two</h2>\n<p>b</p>\n");
  const both = await editFiles(folder, "chapters.html", [
    { old: "<h2>One</h2>", new: "<h3>One</h3>" },
    { old: "<h2>Two</h2>", new: "<h3>Two</h3>" },
    { new: "<p>end</p>\n" },
  ]);
  is(
    "several changes are made in one write, each on the file as the one before left it",
    await readFile(`${folder}/chapters.html`, "utf8"),
    "<h3>One</h3>\n<p>a</p>\n<h3>Two</h3>\n<p>b</p>\n<p>end</p>\n",
  );
  is("and it says the line of each", both.lines, [1, 3, 0]);
  is(
    "when one of them cannot be made, it says which, and none are",
    await why(editFiles(folder, "chapters.html", [{ old: "<h3>One</h3>", new: "x" }, { old: "<h2>Three</h2>", new: "y" }])),
    'Change 2 of 2: That text is not in the file: this line of it is not there: "<h2>Three</h2>". Read that part of the file again and copy it, HTML entities included. None of the changes were made.',
  );
  is("so the file is as it was", (await readFile(`${folder}/chapters.html`, "utf8")).startsWith("<h3>One</h3>"), true);

  const { deleteFiles, moveFiles } = await import("@chloejs/core/services");
  const { existsSync } = await import("node:fs");
  await writeFile(`${folder}/finished.html`, "<h1>Finished</h1>\n");
  await moveFiles(folder, "finished.html", "done/old/finished.html");
  is("a move makes the folders it goes into, and leaves nothing behind", [existsSync(`${folder}/done/old/finished.html`), existsSync(`${folder}/finished.html`)], [true, false]);
  is("a move onto a file that is there is refused", (await why(moveFiles(folder, "book.html", "done/old/finished.html"))).includes("already there"), true);
  is("the whole folder cannot be moved", await why(moveFiles(folder, ".", "elsewhere")), "That is the whole folder. Name a file or a folder inside it.");
  await deleteFiles(folder, "done");
  is("a folder is deleted with everything in it", existsSync(`${folder}/done`), false);
  is("the whole folder cannot be deleted", await why(deleteFiles(folder, "")), "That is the whole folder. Name a file or a folder inside it.");
  is("and nothing outside it can", (await why(deleteFiles(folder, "../outside.html"))) === "not refused", false);
  const { readAsText, readFiles } = await import("@chloejs/core/services");
  is(
    "a read is shown to a model as the file's own text, nothing escaped",
    readAsText("chapters.html", await readFiles(folder, "chapters.html")),
    "chapters.html, all of it:\n\n<h3>One</h3>\n<p>a</p>\n<h3>Two</h3>\n<p>b</p>\n<p>end</p>\n",
  );
  is(
    "and part of one says which lines, and that there is more",
    readAsText("chapters.html", await readFiles(folder, "chapters.html", { from: 2, lines: 1 })),
    "chapters.html, lines 2 to 2 of 6:\nThis is lines 2 to 2 of 6. Ask for from and lines to read another part, or search to find where something is.\n\n<p>a</p>",
  );
}

{
  about("an agent's history, in git");

  const { execFileSync } = await import("node:child_process");
  const { chmod, mkdtemp, mkdir: makeDir, readFile: get, rm, writeFile: put } = await import("node:fs/promises");
  const { realpathSync } = await import("node:fs");
  const { jobsOf, loadAll, markdownJob } = await import("#chloe/load/load");
  const { setAgentDirs } = await import("#chloe/core/paths");
  const { change, commitPaths, makeRepo, markSeen, noteCommit, undo } = await import("#chloe/services/historyService");
  const { skillsIn } = await import("#chloe/load/load");
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
  await put(join(folder, "purpose.md"), "Be brief.");
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

  // A change to its own folder is a commit in the repository it is in.
  const commitAs = async (path: string, content: string, message: string) => {
    await put(join(folder, path), content);
    const id = await commitPaths(folder, [join(folder, path)], { message, author: "keeper" });
    noteCommit("folder", id, message);
    return id;
  };
  await commitAs("jobs/weekly.md", "---\ncron: 0 9 * * 1\ntimezone: America/New_York\n---\nLook back at the week.", "a change worth making");
  is("a change to its folder is committed under the agent's id, with its message", git(repo, "log", "-1", "--format=%an: %s"), "keeper: a change worth making");
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

  // A change made during a run belongs to that run.
  const improve = codeJob("improve", async ({ step }) =>
    step("rewrite the skill", () =>
      commitAs("skills/deploys.md", "---\nname: deploys\ndescription: how\n---\nShip it small.", "the skill says how to ship"),
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

  // Seen from the site.
  await makeDir(join(folder, "scripts"), { recursive: true });
  await put(join(folder, "scripts", "where.sh"), '#!/bin/sh\nprintf %s "$MEMORY_FOLDER"\n');
  await chmod(join(folder, "scripts", "where.sh"), 0o755);
  setAgentDirs(new Map([["keeper", folder]]), new Map([["keeper", memory]]));
  is(
    "the site's view of an agent's folder leaves its memory out",
    (await tree("keeper")).map((one) => one.name),
    ["jobs", "scripts", "skills", "PERMISSIONS.md", "purpose.md"],
  );
  is("and will not open a file in it", await open("keeper", "memory/STATUS.md"), null);

  // A skill that is a folder, with its scripts beside it.
  await makeDir(join(folder, "skills", "forms", "scripts"), { recursive: true });
  await makeDir(join(folder, "skills", "half-made"), { recursive: true });
  await put(join(folder, "skills", "forms", "SKILL.md"), "---\ndescription: filling forms\n---\nRun the script.");
  await put(join(folder, "skills", "forms", "fields.md"), "Longer notes.");
  await put(join(folder, "skills", "forms", "scripts", "here.sh"), "#!/bin/sh\npwd\n");
  await chmod(join(folder, "skills", "forms", "scripts", "here.sh"), 0o755);
  await put(join(folder, "skills", "half-made", "notes.md"), "No SKILL.md yet.");
  is(
    "a skill is a markdown file, or a folder with a SKILL.md, named for the folder",
    (await skillsIn(join(folder, "skills"))).map((one) => [one.name, one.file, one.folder ?? ""]),
    [["deploys", "skills/deploys.md", ""], ["forms", "skills/forms/SKILL.md", "skills/forms"]],
  );
  await put(join(folder, "skills", "forms.md"), "---\nname: forms\n---\nTwice.");
  is(
    "two skills with one name stop the agent loading",
    await skillsIn(join(folder, "skills")).then(() => "", failed),
    "Two skills are called forms: skills/forms/SKILL.md and skills/forms.md.",
  );
  await rm(join(folder, "skills", "forms.md"));
  await loadAll();

  identity.forEach((key, i) => {
    if (before[i] === undefined) delete process.env[key];
    else process.env[key] = before[i];
  });
}
