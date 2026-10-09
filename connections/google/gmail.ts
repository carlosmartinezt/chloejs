// The tools over gmailService.ts: reading the mail an agent is bound
// to, answering one of those messages, and sending one as the signed-in person.
//
// The binding lives in the agent's config, not in anything the model can
// write. For reading, all the model chooses is how far back and how many. For
// replying, it chooses which of the messages it has already listed and what to
// say, and never the address.
//
//   import * as gmail from "@chloejs/core/tools/gmail";
//   tools: { gmailReadEmail: gmail.readEmail({ search: "in:inbox" }) }
import { tool } from "ai";
import { z } from "zod";

import { markdownToHtml, markdownToText } from "#chloe/services/emailService";
import { writeFiles } from "#chloe/services/filesService";
import { readEmailMessages, readOneEmailMessage, replyGmail } from "./gmailService.ts";
import { agentOf } from "#chloe/model/tool";
import { sendingTool, type SendOptions } from "#chloe/model/tools/sending";

import { google } from "./connection.ts";

export type { SendOptions };

/** The options for `gmail.readEmail`. */
interface Options {
  /**
   * The Gmail search that sets which mail the model can see, such as
   * `"in:inbox label:orders"`. The model cannot change it. Default: `"in:inbox"`
   * (the whole inbox).
   *
   * Set your own search to keep the agent to the part of the mailbox it needs.
   */
  search?: string;
  /**
   * A few words for that mail, such as `"order emails"`. Used in the tool's
   * description and messages to the model. Default: `"mail in the inbox"`.
   */
  what?: string;
  /** How many days back to look when the model does not say. Default: 7. */
  days?: number;
}

/**
 * Makes a tool that lets the model read the agent's Gmail. The model lists
 * recent messages, then can read one of them in full.
 *
 * `search` sets which mail the model can see, and the model cannot change it.
 * The model chooses only how many days back (up to 365) and how many messages
 * (up to 50, default 10). It can open only a message that this search lists.
 *
 * Needs the Google connection. If no one has signed in to Google, chloe sends
 * the sign-in link in the chat.
 *
 * ```ts
 * tools: { gmailReadEmail: gmail.readEmail({ search: "in:inbox label:orders" }) }
 * ```
 */
export function readEmail({
  search = "in:inbox",
  what = "mail in the inbox",
  days = 7,
}: Options = {}) {
  const read = tool({
    description:
      `Read ${what}. Lists what is there; pass a messageId from that list to read one in full. ` +
      `You cannot change which mail this searches.`,
    inputSchema: z.object({
      // A year and fifty, because "what did they say in March" and "the last
      // twenty" are both ordinary asks and the old caps refused them. What
      // stops a search being too wide is the agent's binding, not these.
      days: z.number().int().min(1).max(365).optional().describe("How far back to look. Default 7."),
      limit: z.number().int().min(1).max(50).optional().describe("How many at most. Default 10."),
      messageId: z
        .string()
        .optional()
        .describe("Read this one in full. Must be an id this tool already listed."),
    }),
    execute: async ({ days: back, limit, messageId }) =>
      messageId
        ? await readOneEmailMessage({ search, what, days: back ?? days, limit: limit ?? 10, messageId })
        : await readEmailMessages({ search, days: back ?? days, limit: limit ?? 10 }),
  });
  return Object.assign(read, { needs: google });
}

/** The options for `gmail.replyEmail`: the same as `gmail.readEmail`, plus these. */
interface ReplyOptions extends Options {
  /**
   * When the model should use the tool, and how the replies should sound, in
   * your own words. Added to the tool's description for the model. Not set by
   * default.
   */
  when?: string;
  /**
   * Set to `true` to have the model write replies in Markdown. They are then
   * sent as HTML, with a plain text copy. Off by default: the reply is sent as
   * plain text, exactly as written, which usually reads better to a person.
   */
  markdown?: boolean;
  /**
   * A folder in the agent's memory, such as `"outbox"`. Each reply sent is
   * saved there as `<date>-<time>-<subject>.md`, so the agent can check what
   * it already said. Not set by default: no copies are kept.
   */
  keep?: string;
}

/**
 * Makes a tool that lets the model reply to one of the messages it can read.
 * The reply is sent from the signed-in Google account, in the same thread.
 *
 * The model chooses the message and the words, never the address. **The reply
 * always goes to the sender of that message** (or to its Reply-To address).
 * So the model can answer people who wrote in, but cannot email anyone else.
 * This matters because the email the model reads was written by somebody
 * outside, and could hold instructions that try to make it write to another
 * address.
 *
 * Give it the same `search` as the agent's `gmail.readEmail`, so it can reply
 * to exactly the mail that tool lists.
 *
 * Needs the Google connection.
 */
export function replyEmail({
  search = "in:inbox",
  what = "mail in the inbox",
  days = 7,
  when = "",
  markdown = false,
  keep,
}: ReplyOptions = {}) {
  const reply = tool({
    description:
      `Reply to one message in ${what}, as the account that reads it, in that message's own thread. ` +
      `Pass a messageId the mail tool listed. It goes to whoever sent that message: you do not choose ` +
      `the address, and this cannot start a new conversation or reach anybody who has not written in. ` +
      `The subject is taken from the original.${when ? ` ${when}` : ""}`,
    inputSchema: z.object({
      messageId: z.string().describe("The message to answer. Must be an id the mail tool already listed."),
      body: z
        .string()
        .min(20)
        .describe(`${markdown ? "Markdown" : "Plain text"}. What to say, written as the person sending it.`),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Only needed if the message is older than this tool's default."),
    }),
    execute: async ({ messageId, body, days: back }, { context }) => {
      const sent = await replyGmail({
        search,
        what,
        days: back ?? days,
        // Generous, because this only decides how wide the fallback search
        // looks for an id that was listed before this run rather than in it.
        limit: 50,
        messageId,
        body: markdown ? markdownToText(body) : body,
        html: markdown ? markdownToHtml(body) : undefined,
      });
      if (!keep) return sent;
      const at = new Date().toISOString();
      const slug = sent.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
      // Quoted, because the subject is the sender's words: a value that
      // happens to hold a colon is a broken file, and the frontmatter of a
      // file a model reads later is not a place to find out.
      const copy = `---\nto: ${sent.to}\nsubject: ${JSON.stringify(sent.subject)}\nsent: ${at}\n---\n\n${body}\n`;
      const agent = agentOf(context);
      const { folder, commit } = agent.memory;
      // With "each run", the end of the run commits the copy with everything else it wrote.
      const kept = await writeFiles(folder, `${keep}/${at.slice(0, 16).replace("T", "-").replace(":", "")}-${slug}.md`, copy, {
        commit: commit === true,
        message: `Replied: ${sent.subject}`,
        author: agent.id,
        in: "memory",
      });
      return { ...sent, copy: kept.path };
    },
  });
  return Object.assign(reply, { needs: google });
}

/**
 * Makes a tool that lets the model send an email from the signed-in Google
 * account. You set the From line (`from`) and who it goes to (`to`). The model
 * writes only the subject and the body.
 *
 * `from` must be the Google account's own address, or an alias Google has
 * verified for it. If `email.provider` in settings is `"none"`, nothing is
 * sent: the subject is only written to the log.
 *
 * Needs the Google connection.
 *
 * ```ts
 * tools: { gmailSendEmail: gmail.sendEmail({ from: "Shop <you@gmail.com>", to: ["you@gmail.com"], when: "When an order fails." }) }
 * ```
 */
export function sendEmail(options: SendOptions) {
  return Object.assign(sendingTool("gmail", options), { needs: google });
}
