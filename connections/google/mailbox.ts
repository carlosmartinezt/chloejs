// The email channel's way into Gmail: what is new in the mailbox, one message
// whole, and sending in a thread, as the account Google is signed in to.
//
// Only the runtime's own code calls these, never a model. The channel looks at
// the recipients of what is new and fetches a message whole only when it is
// addressed to one of the channel's own addresses, so the rest of the mailbox
// is never read. Every call goes through `googleApi()`, which holds the
// sign-in.
import { googleApi } from "./googleService.ts";

const MAILBOX = "https://gmail.googleapis.com/gmail/v1/users/me";

/** What has arrived since a point in the mailbox, and the point to ask from next time. */
export interface Since {
  added: { id: string; threadId?: string }[];
  history: string;
}

/** What the email channel needs from a mailbox. Gmail is one; a test hands in its own. */
export interface Mailbox {
  /** Where the mailbox is now. Asking from here later gives what arrived in between. */
  now(): Promise<string>;
  /** What arrived since `history`, or "gone" when that point is too old to ask from. */
  since(history: string): Promise<Since | "gone">;
  /** Who a message was sent to: its To and Cc lines, as written. */
  recipients(id: string): Promise<string>;
  /** The whole message, as it arrived. */
  raw(id: string): Promise<string>;
  /** Sends one message (the URL-safe base64 `rawMail()` writes), in a thread when one is named. */
  send(raw: string, threadId?: string): Promise<void>;
}

interface Header {
  name?: string;
  value?: string;
}

/** The signed-in account's mailbox, through Google's own web addresses. */
export const gmailMailbox: Mailbox = {
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
