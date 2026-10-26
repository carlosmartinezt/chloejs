// Memory: the tools, and a note on each person.

import { about, is } from "#chloe/ops/check";
import { agentFor, answers, codeJob, lastAsked, row } from "#chloe/ops/test/shared";

{
  about("the folders of a memory, before the first call");

  const { folderTree } = await import("@chloejs/core/services");
  const { memoryTools } = await import("./tools.ts");
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

  answers.push({ tool_calls: [{ id: "1", type: "function", function: { name: "memoryListFiles", arguments: "{}" } }] }, "Found them.");
  const looked = await turn({ agent: keeper, prompt: "look", source: "test" });
  const called = (JSON.parse(row(looked.runId).trace) as { tool?: string; own?: boolean }[]).find((one) => one.tool);
  is("a call to a tool that touches only the agent is marked own, so the page does not show it as what it is doing", [called?.tool, called?.own], ["memoryListFiles", true]);
}

{
  about("a note on each person");
  const { mkdtemp } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { receive } = await import("#chloe/channels/shared");
  const { userNotesFile, userNotesTools } = await import("./tools.ts");
  const folder = await mkdtemp(`${(await import("node:os")).tmpdir()}/chloe-notes-`);
  const agent = { ...agentFor(codeJob("none", async () => "")), memory: { folder, commit: false as const }, tools: { memoryWriteUserNotes: userNotesTools()().memoryWriteUserNotes } };
  const from = (id: string, text: string) => receive(agent, { channel: "test", chat: id, thread: `test/notes-${id}`, from: { id, name: id }, text, private: true });
  answers.push({ content: "", tool_calls: [{ id: "n1", type: "function", function: { name: "memoryWriteUserNotes", arguments: JSON.stringify({ notes: "Likes short answers." }) } }] });
  answers.push("Noted.");
  await from("42", "keep it short from now on");
  is("the note is kept as that person's, on that channel", existsSync(userNotesFile(folder, "test:42")), true);
  answers.push("Sure.");
  await from("42", "what do I like?");
  is("the next turn starts out with what it noted, in a section naming where it came from", lastAsked[0].content.includes("## Your note on them (from the memory plugin)\n\nLikes short answers."), true);
  answers.push("No notes.");
  await from("43", "and me?");
  is("which nobody else is shown", lastAsked[0].content.includes("Likes short answers."), false);
}

{
  about("where a file in its memory opens");
  const { tool } = await import("ai");
  const { z } = await import("zod");
  const { receive } = await import("#chloe/channels/shared");
  const { settings } = await import("@chloejs/core");
  const fake = (description: string) => tool({ description, inputSchema: z.object({}), execute: async () => description });
  const agent = { ...agentFor(codeJob("none", async () => "")), tools: { memoryReadFile: Object.assign(fake("A note."), { own: true }) } };
  const told = () => lastAsked.find((m) => m.role === "system")?.content ?? "";
  const before = settings.serve;
  settings.serve = { ...before, url: "https://chloe.example.com/" };
  answers.push("Hello.");
  await receive(agent, { channel: "test", chat: "t", thread: "test/links-guest", from: { id: "v", name: "a visitor" }, text: "hi", private: true }, { guests: true, tools: ["memoryReadFile"] });
  is("a guest is not told where the memory opens on the dashboard", told().includes("## Links to your memory"), false);
  answers.push("Here.");
  await receive(agent, { channel: "test", chat: "t", thread: "test/links-named", from: { id: "1", name: "Me" }, text: "a link?", private: true });
  is("anybody else is told the link to a file in its memory, from serve.url", told().includes(`https://chloe.example.com/agents/${agent.id}/memory/<its path`), true);
  settings.serve = before;
}
