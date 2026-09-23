// The tool over services/gmailService.ts: reading mail, bound to a fixed search.
//
// The binding lives in the agent's config, not in anything the model can
// write. All the model chooses is how far back and how many.
import { z } from "zod";

import { readEmailMessages, readOneEmailMessage } from "#chloe/services/gmailService.ts";
import { tool } from "#chloe/model/tool.ts";

interface Options {
  /**
   * Gmail query this agent may see, and nothing else. Set in its config.
   * Unsaid it is `in:inbox`, which is the whole inbox: a binding of its own
   * is what keeps the agent to one slice of the mailbox.
   */
  search?: string;
  /** How to describe that mail in the tool's description, in plain words. */
  what?: string;
  /** Days back when the agent does not say. */
  days?: number;
  id?: string;
}

/**
 * A tool that reads the mail the agent is bound to. The search is the
 * binding's, and the model chooses only how far back and how many.
 */
export function read_mail({
  search = "in:inbox",
  what = "mail in the inbox",
  days = 7,
  id = "read_mail",
}: Options = {}) {
  return tool({
    id,
    description:
      `Read ${what}. Lists what is there; pass a messageId from that list to read one in full. ` +
      `You cannot change which mail this searches.`,
    inputSchema: z.object({
      days: z.number().int().min(1).max(30).optional().describe("How far back to look. Default 7."),
      limit: z.number().int().min(1).max(25).optional().describe("How many at most. Default 10."),
      messageId: z
        .string()
        .optional()
        .describe("Read this one in full. Must be an id this tool already listed."),
    }),
    execute: ({ days: back, limit, messageId }) =>
      messageId
        ? readOneEmailMessage({ search, what, days: back ?? days, limit: limit ?? 10, messageId })
        : readEmailMessages({ search, days: back ?? days, limit: limit ?? 10 }),
  });
}
