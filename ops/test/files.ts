// The folder the page reads and writes, and what a request may send.

import { createServer } from "node:http";
import { z } from "zod";
import { about, is } from "#chloe/ops/check";
import { answer } from "./shared.ts";

{
  about("the folder the page reads and writes");

  const { editable, open, save, tree } = await import("#chloe/serve/files");
  const { agentIds } = await import("@chloejs/core");
  const agent = (await agentIds())[0];

  const top = await tree(agent);
  is("folders come before files", [...top].sort((a, b) => Number(b.dir) - Number(a.dir)), top);
  is(
    "a folder carries what is under it",
    top.some((entry) => entry.dir && (entry.children?.length ?? 0) > 0),
    true,
  );

  is(
    "what a program made is not part of what an agent is",
    JSON.stringify(top).includes("__pycache__"),
    false,
  );

  is("markdown is written back", editable("skills/one.md"), true);
  is("code is not", editable("units.ts"), false);

  const refused = await save(agent, "units.ts", "//").then(() => null, (error: Error) => error.message);
  is("and save refuses it rather than trusting the page", refused, "units.ts is not markdown.");

  // The page hands over a path, so it is as untrusted as one a model wrote.
  const out = await open(agent, "../../etc/passwd").then(() => null, (error: Error) => error.message);
  is("a path out of the agent's folder does not open", out?.startsWith("Path is outside"), true);
}

{
  about("what a request may send");

  const { body, BadRequest } = await import("#chloe/serve/http");
  const { request: httpRequest } = await import("node:http");
  const shape = z.object({ text: z.string().trim().min(1) });
  // A stand-in caller: whatever it is handed is the body of one request.
  const server = createServer(async (request, response) => {
    const answer = await body(request, shape).then(
      (value) => ({ value }),
      (error: Error) => ({ refused: error instanceof BadRequest, why: error.message }),
    );
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const send = async (raw: string) =>
    (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { method: "POST", body: raw })).json();

  is("a body in the shape comes back typed", await send('{"text":" hi "}'), { value: { text: "hi" } });
  is("one that does not fit is refused, saying which field", await send('{"text":5}'), {
    refused: true,
    why: "text Invalid input: expected string, received number",
  });
  is("so is one that is not JSON", await send("not json"), { refused: true, why: "Body is not valid JSON." });

  // 200,000 é is 400,000 bytes: written in odd pieces, so a character
  // straddles a chunk boundary many times over, and has to survive it.
  const words = "é".repeat(200_000);
  const raw = Buffer.from(JSON.stringify({ text: words }), "utf8");
  const pieces = await new Promise<string>((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port: (server.address() as { port: number }).port, method: "POST" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", fail);
    for (let at = 0; at < raw.length; at += 1013) req.write(raw.subarray(at, Math.min(at + 1013, raw.length)));
    req.end();
  });
  is("a body whose characters straddle chunks comes back whole", (JSON.parse(pieces) as { value: { text: string } }).value.text, words);
  server.close();
}

{
  about("a folder that holds the project's credentials and chloe's records");

  // An agent defined in chloe.config.ts lives in the project folder, which
  // holds .env and the state folder. Here the project is the state folder's parent.
  const { mkdtemp, mkdir: makeDir, writeFile: put } = await import("node:fs/promises");
  const { basename, dirname, join: joined } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { confine } = await import("#chloe/core/confine");
  const { listFiles, searchFiles } = await import("#chloe/services/filesService");
  const { STATE, MEMORIES } = await import("#chloe/core/paths");
  const refused = (root: string, path: string) => {
    try {
      confine(root, path);
      return false;
    } catch {
      return true;
    }
  };

  const project = dirname(STATE);
  const records = basename(STATE);
  await put(joined(STATE, "records-under-test.json"), "{}");
  is("the state folder is refused from the folder holding it", refused(project, `${records}/records-under-test.json`), true);
  is("so is the folder itself", refused(project, records), true);
  is("a memory inside the state folder still reads its own files", refused(MEMORIES, "notes.md"), false);
  is("the state folder is left out of a listing", (await listFiles(project)).entries.includes(`${records}/`), false);

  const elsewhere = await mkdtemp(joined(tmpdir(), "chloe-project-"));
  await put(joined(elsewhere, ".env"), "CHLOE_KEY=never shown");
  await put(joined(elsewhere, ".env.local"), "CHLOE_KEY=never shown");
  await makeDir(joined(elsewhere, "skills"));
  await put(joined(elsewhere, "skills", ".env"), "CHLOE_KEY=never shown");
  is(".env is refused", refused(elsewhere, ".env"), true);
  is("so is .env.local", refused(elsewhere, ".env.local"), true);
  is("and one in a folder below", refused(elsewhere, "skills/.env"), true);
  is("a file that only starts alike is not", refused(elsewhere, ".envelope"), false);
  is(
    "searching the folder never reads .env",
    JSON.stringify(await searchFiles(elsewhere, "never shown")).includes("never shown"),
    false,
  );
}

{
  about("the folders an agent may read, with what git ignores left out");

  const { mkdtemp, mkdir: makeDir, writeFile: put, realpath, rm } = await import("node:fs/promises");
  const { join: joined } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { defineAgent } = await import("@chloejs/core");
  const { resolveAgent } = await import("#chloe/load/load");

  const top = await realpath(await mkdtemp(joined(tmpdir(), "chloe-folders-")));
  const shop = joined(top, "shop");
  const notes = joined(top, "notes");
  await makeDir(joined(shop, "src"), { recursive: true });
  await makeDir(joined(shop, "dist"));
  await makeDir(notes);
  await put(joined(shop, ".gitignore"), "dist/\nsecret.txt\n");
  await put(joined(shop, "src", "orders.ts"), "export const orders = 'the order code';\n");
  await put(joined(shop, "dist", "orders.js"), "the order code, built\n");
  await put(joined(shop, "secret.txt"), "the order code is hunter2\n");
  await put(joined(shop, "draft.md"), "the order code, not committed yet\n");
  await put(joined(notes, "plan.md"), "the order code is next\n");
  execFileSync("git", ["init", "-q"], { cwd: shop });
  execFileSync("git", ["add", ".gitignore", "src"], { cwd: shop });

  const folder = await realpath(await mkdtemp(joined(tmpdir(), "chloe-reader-")));
  const agent = (folders: unknown) =>
    resolveAgent(defineAgent({ id: "reader", folder, model: "m", identity: "", purpose: "Hi.", abilities: { folders: folders as never } }));
  const refused = (folders: unknown) => agent(folders).then(() => "loaded", (error: Error) => error.message);
  const { tools = {} } = await agent({ paths: [shop, notes], about: "the shop's code and notes" });
  const call = (name: string, input: unknown) => (tools[name].execute as (input: unknown, options: unknown) => Promise<unknown>)(input, {});
  const said = (name: string, input: unknown) => call(name, input).then((out) => JSON.stringify(out), (error: Error) => error.message);

  is("it adds the three tools and nothing that writes", Object.keys(tools).filter((name) => name.startsWith("folder")).sort(), ["folderListFiles", "folderReadFile", "folderSearchFiles"]);
  is("each folder is named by its last part", JSON.stringify(tools.folderReadFile.inputSchema).includes('"shop"') && JSON.stringify(tools.folderReadFile.inputSchema).includes('"notes"'), true);
  const listed = await said("folderListFiles", { folder: "shop" });
  is("a listing leaves out what git ignores, and keeps what it would add", [listed.includes("src/"), listed.includes("draft.md"), listed.includes("dist"), listed.includes("secret.txt")], [true, true, false, false]);
  is("a file git ignores is refused", (await said("folderReadFile", { folder: "shop", path: "secret.txt" })).includes("left out by git"), true);
  is("one it tracks is read", (await said("folderReadFile", { folder: "shop", path: "src/orders.ts" })).includes("the order code"), true);
  const found = await said("folderSearchFiles", { folder: "shop", query: "the order code" });
  is("a search reads only what git shows", [found.includes("orders.ts"), found.includes("draft.md"), found.includes("hunter2"), found.includes("built")], [true, true, false, false]);
  is("a folder that is no repository shows everything", (await said("folderSearchFiles", { folder: "notes", query: "order code" })).includes("plan.md"), true);
  is("nothing outside the folder is read", (await said("folderReadFile", { folder: "shop", path: "../notes/plan.md" })).includes("outside"), true);
  is("the model is shown each folder's layout", (await tools.folderListFiles.overview!()).includes("shop/\n  src/"), true);

  is("no paths adds nothing", Object.keys((await agent(true)).tools ?? {}).some((name) => name.startsWith("folder")), false);
  is("a folder that is not there is refused", (await refused({ paths: [joined(top, "gone")] })).includes("which is not a folder"), true);
  is("so is a path that is not full", (await refused({ paths: ["shop"] })).includes("Give each one's full path"), true);
  await makeDir(joined(top, "other", "shop"), { recursive: true });
  is("and two that end the same", (await refused({ paths: [shop, joined(top, "other", "shop")] })).includes("two folders called shop"), true);
  await rm(top, { recursive: true, force: true });
  await rm(folder, { recursive: true, force: true });
}
