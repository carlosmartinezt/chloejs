// chatSendFile: a file from the agent's memory, or one somebody sent it, sent
// to the person it is talking with. A turn has it only when its channel can
// send files (`While.sendFile` in channels/shared.ts), and the person is the
// one the channel says, never one the model names.
//
// chatAsk: a question with a few answers to pick from, which ends the reply.
// Every turn in a conversation has it.
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { confine } from "#chloe/core/confine";
import { choicesHint } from "#chloe/services/messageService";
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

/**
 * The tool for a turn in a conversation. Its answer is the reply: the
 * question with a line listing the options, and the options themselves, which
 * a channel with buttons shows as buttons. Their pick is their next message.
 */
export function chatAsk(): ChloeTool {
  return Object.assign(tool({
    description:
      "Ask the person you are talking with to pick from a few answers. Their chat shows each as a button where it can, " +
      "and a box to tick each when they may pick several. Your reply ends with this question, so say anything else first, " +
      "in the question itself. What they pick comes back as their next message. Use it only when the answer is one of a short list.",
    inputSchema: z.object({
      question: z.string().trim().min(1).describe("The question, as you would write it to them."),
      options: z.array(z.string().trim().min(1).max(60)).min(2).max(8).describe("The answers to pick from, 2 to 8, each a few words."),
      multiple: z.boolean().default(false).describe("True when they may pick several."),
    }),
    execute: async ({ question, options, multiple }) => ({
      text: `${question}\n${choicesHint(options, multiple)}`,
      options,
      ...(multiple && { multiple }),
    }),
  }), { title: "Ask a question", own: true, endsReply: true });
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
