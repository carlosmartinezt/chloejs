// What a connector is: an outside account or program chloe works through, like
// Google through gog, or Resend on a key. Each one is a folder in here with its
// tools, its services and a `connector.ts` saying what it needs.
//
// A tool that works through one names it as its `needs`, and the runtime learns
// the rest from the connector and never by name: the loader adds its sign-in
// beside the tool, and the setup page asks it what is missing. A connector in an
// agent's own folder is the same shape and needs nothing from the runtime.
import type { Tools } from "#chloe/model/tool";

export interface Connector {
  /** What the setup page calls it. */
  name: string;
  /** What it is for, in one line. */
  does: string;
  /** The settings it reads, as paths. Never their values. */
  settings: string[];
  /** Tools that get somebody signed in, added to any agent with a tool that needs this connector. */
  signIn?: () => Tools;
  /** What is missing before it works, one line each, in words. Empty when it is ready. */
  missing(): Promise<string[]>;
}
