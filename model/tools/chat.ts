// chatSendFile: a file from the agent's memory, or one somebody sent it, sent
// to the person it is talking with. A turn has it only when its channel can
// send files (`While.sendFile` in channels/shared.ts), and the person is the
// one the channel says, never one the model names.
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { confine } from "#chloe/core/confine";
import type { ChloeTool } from "../tool.ts";

/** A file to send: where it is on disk, and the name the person sees. */
export interface FileToSend {
  path: string;
  name: string;
}

/**
 * The tool for one turn.
 *
 * - `send`: the channel's way to send a file into this conversation.
 * - `folders`: where a file may come from, full paths. Anything outside them is refused.
 */
export function chatSendFile(send: (file: FileToSend) => Promise<void>, folders: string[]): ChloeTool {
  return Object.assign(tool({
    description:
      "Send a file to the person you are talking with, as an attachment in this chat. The file must be in " +
      "your memory, or be one they sent you (its path was in their message).",
    inputSchema: z.object({
      path: z.string().describe("The file: a path inside your memory, or the full path of a file they sent."),
      name: z.string().optional().describe("The name they see, like form-filled.pdf. Default: the file's own name."),
    }),
    execute: async ({ path, name }) => {
      const resolved = inside(folders, path);
      const info = await stat(resolved).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`There is no file at ${path}.`);
      const file = { path: resolved, name: name || basename(resolved) };
      await send(file);
      return { sent: file.name, bytes: info.size };
    },
  }), { title: "Send file" });
}

/** The full path of `path` inside the first of `folders` that holds it, or a throw saying where files may come from. */
function inside(folders: string[], path: string): string {
  for (const folder of folders) {
    try {
      return confine(folder, path);
    } catch {
      // Try the next one.
    }
  }
  throw new Error(`${path} is not in your memory or among the files sent to you, so it cannot be sent.`);
}
