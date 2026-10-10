// The email channel's way into Gmail: what is new in the mailbox, one message
// whole, and sending in a thread, as the account Google is signed in to.
//
// Only the runtime's own code calls these, never a model. The channel looks at
// the recipients of what is new and fetches a message whole only when it is
// addressed to one of the channel's own addresses, so the rest of the mailbox
// is never read. Every call goes through `googleApi()`, which holds the
// sign-in.
import type { Inbox, Since } from "#chloe/core/mail";
import { settings } from "#chloe/core/settings";

import { googleApi } from "./googleService.ts";

const MAILBOX = "https://gmail.googleapis.com/gmail/v1/users/me";

interface Header {
  name?: string;
  value?: string;
}

/** The signed-in account's mailbox, through Google's own web addresses. */
export const gmailMailbox: Inbox = {
  account() {
    const said = settings.connections.google.account.trim().toLowerCase();
    if (!said.includes("@")) {
      throw new Error(`An email channel on Gmail sends from the account Google is signed in to, and there is none. Put it in settings as connections: { google: { account: "you@gmail.com" } }.`);
    }
    return said;
  },

  async now() {
    const profile = await googleApi<{ historyId?: string }>(`${MAILBOX}/profile`);
    if (!profile.historyId) throw new Error("Gmail did not say where the mailbox is up to.");
    return profile.historyId;
  },

  async since(history) {
    const added: Since["added"] = [];
    let page: string | undefined;
    let latest = history;
    do {
      let answer: { history?: { messagesAdded?: { message?: { id?: string; threadId?: string; labelIds?: string[] } }[] }[]; historyId?: string; nextPageToken?: string };
      try {
        answer = await googleApi(`${MAILBOX}/history`, { query: { startHistoryId: history, historyTypes: "messageAdded", pageToken: page } });
      } catch (error) {
        // Google keeps about a week of history, and answers 404 for a point older than that.
        if (/404|notFound|Requested entity was not found/i.test((error as Error).message)) return "gone";
        throw error;
      }
      for (const one of answer.history ?? []) {
        for (const { message } of one.messagesAdded ?? []) {
          if (message?.id && !message.labelIds?.includes("DRAFT")) added.push({ id: message.id, threadId: message.threadId });
        }
      }
      latest = answer.historyId ?? latest;
      page = answer.nextPageToken;
    } while (page);
    return { added, history: latest };
  },

  async recipients(id) {
    const message = await googleApi<{ payload?: { headers?: Header[] } }>(`${MAILBOX}/messages/${encodeURIComponent(id)}`, {
      query: { format: "metadata", metadataHeaders: ["To", "Cc"] },
    });
    return (message.payload?.headers ?? []).map((one) => one.value ?? "").join(", ");
  },

  async raw(id) {
    const message = await googleApi<{ raw?: string }>(`${MAILBOX}/messages/${encodeURIComponent(id)}`, { query: { format: "raw" } });
    return Buffer.from(message.raw ?? "", "base64url").toString("latin1");
  },

  async send(raw, threadId) {
    await googleApi(`${MAILBOX}/messages/send`, { method: "POST", body: threadId ? { raw, threadId } : { raw } });
  },
};
