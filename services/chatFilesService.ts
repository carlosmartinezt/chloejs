// The files a reply hands over on the page: a picture or a PDF the person asked
// for, kept for as long as the conversation it is in.
//
// A reply names one in its words, as `![what it shows](file:<agent>/<id>)` or
// `[its name](file:<agent>/<id>)`, so the message is the one record of where it
// goes, and a fork of the conversation has it too. The page reads that and asks
// the runtime for the file, and shows it only to whoever asked for the reply,
// or to anybody signed in reading a conversation that was shared.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

import { db } from "#chloe/core/db";
import { STATE } from "#chloe/core/paths";

/** The largest file a reply can hand over, in bytes. */
const LARGEST = 25_000_000;

/** A file no message names after this long, in milliseconds, is one whose reply failed. */
const UNUSED_AFTER = 86_400_000;

const FOLDER = () => `${STATE}/chat-files`;

/** A file a reply handed over. */
export interface ChatFile {
  /** Where it is on disk. */
  path: string;
  /** The name the person sees. */
  name: string;
  /** Its type, read from its first bytes, never from its name. */
  type: string;
}

/**
 * What a file's first bytes say it is: "image/png", "image/jpeg", "image/gif",
 * "image/webp" or "application/pdf". Anything else is
 * "application/octet-stream", which a browser only downloads. An SVG is one of
 * those, because it can carry a script.
 */
export function typeOfFile(data: Buffer): string {
  const says = (text: string, at = 0) => data.subarray(at, at + text.length).toString("latin1") === text;
  if (says("\x89PNG\r\n\x1a\n")) return "image/png";
  if (says("\xff\xd8\xff")) return "image/jpeg";
  if (says("GIF87a") || says("GIF89a")) return "image/gif";
  if (says("RIFF") && says("WEBP", 8)) return "image/webp";
  if (says("%PDF-")) return "application/pdf";
  return "application/octet-stream";
}

/**
 * Keeps a copy of a file for one conversation, and returns the line that shows
 * it in a reply. Throws when the file is over the size a reply can hand over.
 *
 * - `agent`: the agent's id.
 * - `thread`: the conversation.
 * - `asker`: who asked for the reply, the only one who gets it back.
 * - `file`: where it is, and the name the person sees.
 */
export async function keepChatFile(agent: string, thread: string, asker: string, file: { path: string; name: string }): Promise<string> {
  if (statSync(file.path).size > LARGEST) throw new Error(`${file.name} is over ${LARGEST / 1_000_000} MB, too large to send here.`);
  dropUnusedFiles();
  const id = randomUUID();
  const data = await readFile(file.path);
  const type = typeOfFile(data);
  await mkdir(FOLDER(), { recursive: true, mode: 0o700 });
  await writeFile(`${FOLDER()}/${id}`, data, { mode: 0o600 });
  const name = basename(file.name).replace(/[\]\[()\n\r]+/g, " ").trim() || "file";
  db.prepare("insert into chat_files (id, agent, thread, asker, name, type, at) values (?, ?, ?, ?, ?, ?, ?)").run(id, agent, thread, asker, name, type, new Date().toISOString());
  const words = type.startsWith("image/") ? name.slice(0, name.length - extname(name).length) : name;
  return `${type.startsWith("image/") ? "!" : ""}[${words}](file:${agent}/${id})`;
}

/** The file with this id, when it is this agent's and this person asked for it. Otherwise undefined. */
export function chatFileFor(agent: string, id: string, asker: string): ChatFile | undefined {
  const row = db.prepare("select name, type from chat_files where id = ? and agent = ? and asker = ?").get(id, agent, asker) as { name: string; type: string } | undefined;
  return row && { path: `${FOLDER()}/${id}`, ...row };
}

/** The file with this id when a shared conversation names it. Otherwise undefined. */
export function sharedChatFile(agent: string, id: string): ChatFile | undefined {
  const row = db
    .prepare(
      `select name, type from chat_files where id = ? and agent = ? and exists (
         select 1 from messages m join threads t on t.thread = m.thread where t.shared is not null and instr(m.content, ?) > 0
       )`,
    )
    .get(id, agent, `](file:${agent}/${id})`) as { name: string; type: string } | undefined;
  return row && { path: `${FOLDER()}/${id}`, ...row };
}

/**
 * The headers that say how a browser treats a file. A picture or a PDF opens
 * in it, and anything else only downloads, in a sandbox even if somebody opens
 * its address, so nothing a reply hands over runs as the person signed in.
 * A browser will not start its PDF viewer in a sandbox.
 */
export function chatFileHeaders(file: ChatFile): Record<string, string> {
  const opens = file.type !== "application/octet-stream";
  const name = encodeURIComponent(file.name);
  return {
    "content-type": file.type,
    "content-disposition": `${opens ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
    "content-security-policy": file.type === "application/pdf" ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; frame-ancestors 'self'",
  };
}

/**
 * Deletes the files no message names any more: any of this conversation's, and
 * any of a day old from a reply that failed or a fork since deleted.
 *
 * - `thread`: the conversation that just lost messages. Leave it out while a
 *   reply is being written, because what that reply sent is not in a message yet.
 */
export function dropUnusedFiles(thread?: string): void {
  const before = new Date(Date.now() - UNUSED_AFTER).toISOString();
  const rows = db.prepare("select id, agent from chat_files where thread = ? or at <= ?").all(thread ?? "", before) as { id: string; agent: string }[];
  if (!rows.length) return;
  const said = (db.prepare("select content from messages where content like '%](file:%'").all() as { content: string }[]).map((one) => one.content).join("\n");
  for (const { id, agent } of rows) {
    if (said.includes(`](file:${agent}/${id})`)) continue;
    db.prepare("delete from chat_files where id = ?").run(id);
    rmSync(`${FOLDER()}/${id}`, { force: true });
  }
}
