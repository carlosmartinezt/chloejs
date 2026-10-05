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
 * How somebody signs in to a connection from a chat. Three plain functions, run
 * by the runtime: a model never starts a sign-in, never copies its link and
 * never handles what comes back, because a model asked to copy a long link
 * rewrites it.
 */
export interface SignIn {
  /**
   * Start one, and say what to send the person: `say` in words, and `link`, the
   * address they open, sent exactly as it is. No link when there is nothing to
   * open yet, like a client nobody has made, and then `say` is the steps.
   */
  start(): Promise<{ say: string; link?: string }>;
  /**
   * Whether a message is the answer to a sign-in that is waiting. Reads files
   * and nothing else, because it is asked of every message, and is strict:
   * a message it claims never reaches the model.
   */
  answers(text: string): boolean;
  /** Finish with that answer, and say what to tell the person. Throws in words they can act on. */
  finish(text: string): Promise<string>;
}

/**
 * An outside account a tool works through. A tool names it as its `needs`, and
 * the runtime asks it what is missing and runs its sign-in.
 */
export interface Connection {
  /** What the setup page calls it, and what `NeedsSignIn` names. */
  name: string;
  /** What it is for, in one line. */
  does: string;
  /** The settings it reads, as paths. Never their values. */
  settings: string[];
  /** How somebody signs in from a chat, when it can be done from one. */
  signIn?: SignIn;
  /** What is missing before it works, one line each, in words. Empty when it is ready. */
  missing(): Promise<string[]>;
}

/**
 * Thrown by a connection's service when what failed is fixed by signing in: no
 * sign-in, one that expired or was taken back, one not allowed to do this. A
 * turn that meets it stops and the runtime starts the sign-in itself, so the
 * message is for a person, not for a model to act on.
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
