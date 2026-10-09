// What a connection is: an outside account chloe works through, like Google or
// Resend. Each one is a folder in here with its tools, its services and a
// `connection.ts` saying what it needs.
//
// A tool that works through one names it as its `needs`, and the runtime learns
// the rest from the connection and never by name: the setup page asks it what is
// missing, and a sign-in is the runtime's to run, never the model's. When a
// tool throws `NeedsSignIn`, the turn stops, the runtime starts the connection's
// sign-in and sends its words and link as written, and the answer the person
// sends back is caught by `receive()` before any model sees it. A connection in
// an agent's own folder is the same shape and needs nothing from the runtime.

/**
 * How a person signs in to a connection from a chat. chloe runs these three
 * functions itself. The model never starts a sign-in, never sees the link and
 * never sees the answer, because a model asked to copy a long link changes it.
 */
export interface SignIn {
  /**
   * Starts a sign-in and returns what to send the person: `say` is the words,
   * and `link` is the address they open. chloe sends the link exactly as you
   * return it.
   *
   * Leave out `link` when there is nothing to open yet (for example, the
   * account has no app set up). Then put the steps to follow in `say`.
   */
  start(): Promise<{ say: string; link?: string }>;
  /**
   * Returns `true` if a chat message is the answer to a sign-in that is
   * waiting, such as a pasted code. chloe checks every message with it, so keep
   * it fast: read files, nothing slower. Be strict: a message it returns `true`
   * for never reaches the model.
   */
  answers(text: string): boolean;
  /**
   * Finishes the sign-in with that answer and returns what to tell the person.
   * When it fails, throw an error whose message tells the person what to do.
   */
  finish(text: string): Promise<string>;
}

/**
 * An outside account or service that a tool works through, such as Google.
 *
 * A tool names its connection in its `needs` field. chloe then asks the
 * connection what is missing, shows that on the dashboard, and runs its
 * sign-in when the tool throws `NeedsSignIn`.
 */
export interface Connection {
  /** The connection's name, as shown on the dashboard, such as `"google"`. `NeedsSignIn` uses the same name. Required. */
  name: string;
  /** What the connection is for, in one line, shown on the dashboard. Required. */
  does: string;
  /**
   * The settings it reads, as paths such as `"connections.resend.api_key"`.
   * Shown on the dashboard. Never put the values here. Required (can be empty).
   */
  settings: string[];
  /** How a person signs in from a chat. Leave it out if they cannot sign in from a chat. */
  signIn?: SignIn;
  /**
   * Returns what is still missing before the connection works, one short
   * line each. Returns an empty list when it is ready. Shown on the dashboard
   * and printed when chloe starts.
   */
  missing(): Promise<string[]>;
}

/**
 * Throw this from a connection's code when signing in would fix the error: no
 * one has signed in, the sign-in expired or was taken back, or it does not
 * allow this action.
 *
 * When a tool throws it during a chat, the model's reply stops, and chloe
 * starts the connection's sign-in and sends the link to the person. So write
 * the message for a person, not for the model. In a job, with no one to
 * answer, the run fails with the message.
 */
export class NeedsSignIn extends Error {
  /** The `name` of the connection to sign in to. */
  readonly connection: string;
  constructor(connection: string, message: string) {
    super(message);
    this.name = "NeedsSignIn";
    this.connection = connection;
  }
}
