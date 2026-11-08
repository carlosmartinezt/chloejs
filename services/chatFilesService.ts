// The files in a conversation on the page: a picture or a PDF the person asked
// for, or one they sent.
//
// Each is a file in the agent's memory (one sent, or one a reply made, is
// kept in `attachments/` there), so its owner can browse it and the agent can find
// it again, and it stays when the conversation goes. A message names one in
// its words, as `![what it shows](file:<agent>/<id>)` or
// `[its name](file:<agent>/<id>)`, so the message is the one record of where
// it goes, and a fork of the conversation has it too. The page reads that and
// asks the runtime for the file, and shows it only to whoever it was for, or
// to anybody signed in reading a conversation that was shared. What says who
// may open it is a row here, which goes with the last message naming it.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, extname, isAbsolute, relative } from "node:path";

import { confine } from "#chloe/core/confine";
import { db } from "#chloe/core/db";
import { keepInMemory } from "./receivedService.ts";

/** The agent a file is kept for: its id and its memory folder. */
interface Whose {
  id: string;
  memory: { folder: string };
}

/** The largest file a reply can hand over, in bytes. */
const LARGEST = 25_000_000;

/** A file's row no message names after this long, in milliseconds, is one whose reply failed. */
const UNUSED_AFTER = 86_400_000;

/** A file in a conversation. */
export interface ChatFile {
  /** Where it is on disk, inside the agent's memory. */
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
 * Lets one person open a file in one conversation, and returns the line that
 * shows it in a message. A file in the agent's memory is shown where it is;
 * any other is copied into `attachments/` there first. Throws when the file is over
 * the size a conversation takes.
 *
 * - `agent`: the agent, whose memory it is in.
 * - `thread`: the conversation.
 * - `asker`: who it is for, the only one who may open it.
 * - `file`: where it is, and the name the person sees.
 */
export async function keepChatFile(agent: Whose, thread: string, asker: string, file: { path: string; name: string }): Promise<string> {
  if (statSync(file.path).size > LARGEST) throw new Error(`${file.name} is over ${LARGEST / 1_000_000} MB, too large to send here.`);
  dropUnusedFiles();
  const data = await readFile(file.path);
  const type = typeOfFile(data);
  const inMemory = relative(agent.memory.folder, file.path);
  const path = !inMemory.startsWith("..") && !isAbsolute(inMemory) ? inMemory : relative(agent.memory.folder, await keepInMemory(agent.memory.folder, file.name, data));
  const id = randomUUID();
  const name = basename(file.name).replace(/[\]\[()\n\r]+/g, " ").trim() || "file";
  db.prepare("insert into chat_files (id, agent, thread, asker, name, type, at, path) values (?, ?, ?, ?, ?, ?, ?, ?)").run(id, agent.id, thread, asker, name, type, new Date().toISOString(), path);
  const words = type.startsWith("image/") ? name.slice(0, name.length - extname(name).length) : name;
  return `${type.startsWith("image/") ? "!" : ""}[${words}](file:${agent.id}/${id})`;
}

/** The file of a row, inside the agent's memory, or undefined when it is no longer there. */
function fileOf(agent: Whose, row: { name: string; type: string; path: string } | undefined): ChatFile | undefined {
  if (!row?.path) return undefined;
  try {
    return { ...row, path: confine(agent.memory.folder, row.path) };
  } catch {
    return undefined;
  }
}

/** The file with this id, when it is this agent's and is for this person. Otherwise undefined. */
export function chatFileFor(agent: Whose, id: string, asker: string): ChatFile | undefined {
  return fileOf(agent, db.prepare("select name, type, path from chat_files where id = ? and agent = ? and asker = ?").get(id, agent.id, asker) as { name: string; type: string; path: string } | undefined);
}

/**
 * The file with this id when a reply in a shared conversation names it, and
 * the file is of whoever shared that conversation. Otherwise undefined. Anybody
 * can write a file's line into their own conversation, so sharing hands over
 * only what was the sharer's already: the owner's, or that one person's.
 */
export function sharedChatFile(agent: Whose, id: string): ChatFile | undefined {
  const row = db
    .prepare(
      `select name, type, path from chat_files f where f.id = ? and f.agent = ? and exists (
         select 1 from messages m join threads t on t.thread = m.thread
         where t.shared is not null and m.role = 'assistant' and instr(m.content, ?) > 0
           and case when f.asker = 'owner' then t.owner is null or t.owner not in (select email from people) else f.asker = 'member:' || t.owner end
       )`,
    )
    .get(id, agent.id, `](file:${agent.id}/${id})`) as { name: string; type: string; path: string } | undefined;
  return fileOf(agent, row);
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
 * Forgets who may open the files no message names any more: any of this
 * conversation's, and any of a day old from a reply that failed or a fork
 * since deleted. The files stay in the agent's memory.
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
  }
}
