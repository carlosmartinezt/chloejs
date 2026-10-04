// The tools over services/gmailService.ts: reading the mail an agent is bound
// to, and answering one of those messages.
//
// The binding lives in the agent's config, not in anything the model can
// write. For reading, all the model chooses is how far back and how many. For
// replying, it chooses which of the messages it has already listed and what to
// say, and never the address.
import { z } from "zod";

import { markdownToHtml, markdownToText } from "#chloe/services/emailService";
import { writeFiles } from "#chloe/services/filesService";
import { readEmailMessages, readOneEmailMessage, replyGmail } from "#chloe/services/gmailService";
import { defineTool, type Tools } from "#chloe/model/tool";
import { googleSignInTools } from "./google.ts";

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
 *
 * It comes with the Google sign-in, because mail that cannot be read because
 * nobody has signed in is not a different problem from mail: an agent that can
 * read mail can get itself signed in to read mail. Nothing to add, and no way
 * to have one without the other.
 */
export function readMail({
  search = "in:inbox",
  what = "mail in the inbox",
  days = 7,
  id = "readMail",
}: Options = {}): Tools {
  const read = defineTool({
    id,
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
    execute: ({ days: back, limit, messageId }) =>
      messageId
        ? readOneEmailMessage({ search, what, days: back ?? days, limit: limit ?? 10, messageId })
        : readEmailMessages({ search, days: back ?? days, limit: limit ?? 10 }),
  });
  return { [id]: read, ...googleSignInTools() };
}

interface ReplyOptions extends Options {
  /** When to use it, and anything about how to sound. In the agent's own words, shown to the model. */
  when?: string;
  /**
   * The body is Markdown: sent as HTML with a plain text copy beside it. Off,
   * it goes as written. A reply to a person usually reads better as plain text,
   * so this is off unless the agent asks for it.
   */
  markdown?: boolean;
  /**
   * A folder in the agent's memory, like "outbox". Every reply sent is copied
   * there as `<date>-<time>-<subject>.md`, so the agent can see what it already
   * said before saying it again. Unsaid, nothing is kept.
   */
  keep?: string;
}

/**
 * A tool that answers one of the messages the agent can already read.
 *
 * It sends as the signed-in account, inside the original thread. **The address
 * is read off the message being answered and is never the model's to choose**,
 * so this grants the ability to answer somebody who wrote in, not the ability
 * to mail a stranger. That matters more here than anywhere else: the text the
 * model is reacting to was written by whoever sent the mail, so an instruction
 * buried in an email that talked the model into mailing an address of its own
 * choosing is the whole risk, and the only reliable answer is for the address
 * not to be an input.
 *
 * Give it the same `search` as the agent's `readMail`, so the mail it can
 * answer is exactly the mail that search lists.
 */
export function replyMail({
  search = "in:inbox",
  what = "mail in the inbox",
  days = 7,
  id = "replyMail",
  when = "",
  markdown = false,
  keep,
}: ReplyOptions = {}) {
  return (agent: { name: string; memory: { folder: string; commit?: boolean | "each run" } }): Tools => ({
    ...googleSignInTools(),
    [id]: defineTool({
      id,
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
      execute: async ({ messageId, body, days: back }) => {
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
        const { folder, commit } = agent.memory;
        // With "each run", the end of the run commits the copy with everything else it wrote.
        const kept = await writeFiles(folder, `${keep}/${at.slice(0, 16).replace("T", "-").replace(":", "")}-${slug}.md`, copy, {
          commit: commit === true,
          message: `Replied: ${sent.subject}`,
          author: agent.name,
          in: "memory",
        });
        return { ...sent, copy: kept.path };
      },
    }),
  });
}
