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
