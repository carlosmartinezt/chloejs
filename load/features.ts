// The features an agent can switch on: tools that chloe brings, each `true`
// or `false` in the agent's `features`, and a few with fields that say what
// they may reach. This is the one list: the loader adds each feature's tools
// from it, and the dashboard draws its switches and forms from it.
import { settings } from "#chloe/core/settings";
import { google } from "#chloe/connections/google/connection";
import * as calendar from "#chloe/connections/google/calendar";
import * as drive from "#chloe/connections/google/drive";
import * as gmail from "#chloe/connections/google/gmail";
import type { Connection } from "#chloe/connections/connection";
import { memoryTools, userNotesTools } from "#chloe/model/tools/memory";
import { scriptTools } from "#chloe/model/tools/script";
import { selfWriteTools } from "#chloe/model/tools/self";
import { readPage } from "#chloe/model/tools/web";
import type { Tools } from "#chloe/model/tool";
import { scriptsIn } from "#chloe/services/scriptsService";
import type { Home } from "./load.ts";
import { defaultOf, readOptions, type OptionSpec } from "./options.ts";

/**
 * Tools that chloe can add to an agent, each switched on or off with `true`
 * or `false`, for example `features: { runScripts: true }`. A few take their
 * fields instead of `true`, like `email: { search: "in:inbox", days: 3 }`; the
 * file says only what differs from the default. The page's Tools view
 * switches them and fills the fields in, by changing this object in
 * `agent.ts`. `FEATURES` is the list, with what each one is when unsaid.
 */
export interface Features {
  /**
   * Adds the memory tools: `memoryListFiles`, `memoryReadFile`,
   * `memorySearchFiles` and `memoryEditFile`. They work on
   * the agent's memory folder (see `memory` on the agent). On by default.
   */
  memory?: boolean;
  /**
   * Adds the tool `webReadPage`, which reads one public web page as plain
   * text. Off by default. It reads only public addresses and does not run the
   * page's JavaScript.
   */
  web?: boolean;
  /**
   * Adds the tool `selfWriteFile`, which lets the agent change its own files:
   * its instructions, skills and jobs, and its code (`agent.ts`, jobs, tools,
   * services, channels, scripts). On by default, which suits an agent that is
   * still being shaped; switch it off once it does what you want.
   *
   * Each change is saved as a git commit, so you can see it and undo it on
   * the dashboard. A change with code in it is loaded and type checked first,
   * and put back with the reason when that fails. The agent can only use this
   * tool in a reply to a message from its owner. It cannot use it after
   * another tool in the same reply has read something from outside the agent
   * (an email, a web page, a script's output, one of its past runs). It never
   * writes its `evals/` folder or its memory.
   *
   * Warning: code the agent writes then runs on your machine with the same
   * rights as chloe.
   *
   * Every agent can already read its own files in every turn
   * (`selfListFiles`, `selfReadFile`) and its past runs (`selfListRuns`,
   * `selfReadRun`), and try one of its jobs (`selfTryJob`), in replies to its
   * owner. It does not need this setting for that.
   */
  selfImprovement?: boolean;
  /**
   * Adds the tool `scriptRun`, which lets the agent run any file in its own
   * `scripts/` folder. Off by default.
   *
   * Each script runs as a program, so it must be executable (`chmod +x`, with
   * a `#!` first line). It runs inside the `scripts/` folder, and gets the
   * agent's memory folder in the `MEMORY_FOLDER` environment variable. If this
   * is on and `scripts/` is empty, the agent does not load.
   *
   * Write a skill that tells the agent when to use each script.
   */
  runScripts?: boolean;
  /**
   * Adds the tool `memoryWriteUserNotes`, which keeps one note about each
   * person the agent talks to, on any channel. Off by default.
   *
   * The notes are files in the agent's memory, like
   * `users/telegram-12345.md`. chloe picks whose note it is from who sent the
   * message, and the model cannot choose. The model sees that person's note
   * at the start of each reply to them. One person on two channels has two
   * notes.
   */
  memoryPerUser?: boolean;
  /**
   * Adds the tools that read the Gmail account Google is signed in to,
   * `emailReadMail`, and with the fields below, `emailReplyMail` and
   * `emailSendMail`. Off by default. `true` reads the inbox of the last 7
   * days and nothing else. Give fields to say which mail, and to let it reply
   * or send. Needs the Google sign-in.
   */
  email?: boolean | EmailFeature;
  /**
   * Adds the tool `calendarListEvents` for a Google calendar, and with
   * `add`, `calendarAddEvent`. Off by default. `true` reads the signed-in
   * account's own calendar for the next 7 days. Needs the Google sign-in.
   */
  calendar?: boolean | CalendarFeature;
  /**
   * Adds the tools `driveSearchFiles` and `driveReadFile`, which find and read
   * files in Google Drive as text. Off by default. `true` reaches all of
   * Drive: give `search` to keep it to some files. Needs the Google sign-in.
   */
  drive?: boolean | DriveFeature;
}

/** The fields of `features.email`. The model chooses only how far back and which listed message to answer. */
export interface EmailFeature {
  /** A Gmail search that sets which mail the model can see, like `"in:inbox label:orders"`. It cannot change it. Default: `"in:inbox"`. */
  search?: string;
  /** How many days back it looks when it does not say. Default: 7. */
  days?: number;
  /** A few words for that mail, like `"order emails"`, said to the model. Default: none. */
  about?: string;
  /** Let it reply to a message it has read, in that message's thread, to whoever wrote it. Off by default. */
  reply?: boolean;
  /** The addresses it may write to. With any, it gets `emailSendMail`, which writes only the subject and the body. Default: none, so it cannot send. */
  sendTo?: string[];
  /** The From line it sends under, like `"Shop <you@gmail.com>"`. Default: the signed-in account. */
  sendFrom?: string;
  /** When it should send, in your words, said to the model. Default: "When asked to." */
  sendWhen?: string;
}

/** The fields of `features.calendar`. */
export interface CalendarFeature {
  /** The ids of the calendars it can see; `"primary"` is the signed-in account's own. Default: `["primary"]`. */
  calendars?: string[];
  /** How many days ahead it looks when it does not say. Default: 7. */
  days?: number;
  /** A few words for those calendars, like `"the team calendar"`, said to the model. Default: none. */
  about?: string;
  /** Let it add an event to the first calendar. The event invites nobody. Off by default. */
  add?: boolean;
}

/** The fields of `features.drive`. */
export interface DriveFeature {
  /** A Drive search that sets which files the model can see, like `"'folder-id' in parents"`. It cannot change it. Default: all of Drive. */
  search?: string;
  /** A few words for those files, like `"the shared proposals"`, said to the model. Default: none. */
  about?: string;
}

/** One feature: what it is when unsaid, what it does in a line, the tools it adds and the fields it takes. */
export interface Feature {
  name: keyof Features;
  /** What the dashboard calls it. */
  label: string;
  on: boolean;
  does: string;
  /** Every tool it can add. Which it does add can depend on its fields. */
  tools: string[];
  /** The fields it takes besides being on, when it takes any. */
  fields?: OptionSpec[];
  /** Fields that bring every tool, so the page can show what they would add. */
  preview?: Record<string, unknown>;
  /** The connection its tools work through. */
  needs?: Connection;
}

const about = (what: string): OptionSpec => ({
  name: "about",
  label: "About it",
  about: `A few words for ${what}, said to the model. Optional.`,
  kind: "words",
  default: "",
});

/** Every feature, in the order the page shows them: self improvement first, then memory, scripts and notes per person, then what reaches outside. A test holds `tools` to what each one adds. */
export const FEATURES: Feature[] = [
  {
    name: "selfImprovement",
    label: "Self improvement",
    on: true,
    does: "Changes its own instructions, skills, jobs and code when you ask it to. Each change is a commit you can undo.",
    tools: ["selfWriteFile"],
  },
  {
    name: "memory",
    label: "Memory",
    on: true,
    does: "Keeps notes in its memory folder, so one run can leave the next better informed.",
    tools: ["memoryListFiles", "memoryReadFile", "memorySearchFiles", "memoryEditFile"],
  },
  {
    name: "runScripts",
    label: "Run scripts",
    on: false,
    does: "Runs the scripts in its scripts/ folder and in its skills' folders.",
    tools: ["scriptRun"],
  },
  {
    name: "memoryPerUser",
    label: "Memory per user",
    on: false,
    does: "Keeps a note on each person it talks to, and reads it before each reply to them.",
    tools: ["memoryWriteUserNotes"],
  },
  {
    name: "web",
    label: "Browse web",
    on: false,
    does: "Reads public web pages as plain text.",
    tools: ["webReadPage"],
  },
  {
    name: "email",
    label: "Email",
    on: false,
    does: "Reads the Gmail it may see, and can reply to it or write to people you name.",
    tools: ["emailReadMail", "emailReplyMail", "emailSendMail"],
    needs: google,
    fields: [
      { name: "search", label: "Mail it may read", about: "A Gmail search, like in:inbox label:orders. It cannot change it.", kind: "words", default: "in:inbox" },
      { name: "days", label: "Days back", about: "How far back it looks when it does not say.", kind: "number", default: 7 },
      about("that mail"),
      { name: "reply", label: "May reply", about: "Reply to a message it has read, in its thread, to whoever wrote it.", kind: "yesno", default: false },
      { name: "sendTo", label: "May write to", about: "Addresses it may send mail to. Empty: it cannot send.", kind: "list", default: [] },
      { name: "sendFrom", label: "Send as", about: "The From line, like Shop <you@gmail.com>. Empty: the signed-in account.", kind: "words", default: "" },
      { name: "sendWhen", label: "When to send", about: "When it should write, said to the model.", kind: "words", default: "When asked to." },
    ],
    preview: { reply: true, sendTo: ["you@example.com"] },
  },
  {
    name: "calendar",
    label: "Calendar",
    on: false,
    does: "Reads events on the Google calendars it may see, and can add one.",
    tools: ["calendarListEvents", "calendarAddEvent"],
    needs: google,
    fields: [
      { name: "calendars", label: "Calendars", about: "The ids of the calendars it may see. primary is the signed-in account's own.", kind: "list", default: ["primary"] },
      { name: "days", label: "Days ahead", about: "How far ahead it looks when it does not say.", kind: "number", default: 7 },
      about("those calendars"),
      { name: "add", label: "May add events", about: "Add an event to the first calendar. It invites nobody.", kind: "yesno", default: false },
    ],
    preview: { add: true },
  },
  {
    name: "drive",
    label: "Drive",
    on: false,
    does: "Finds and reads files in Google Drive as text.",
    tools: ["driveSearchFiles", "driveReadFile"],
    needs: google,
    fields: [
      { name: "search", label: "Files it may see", about: "A Drive search, like one folder. Empty: all of Drive. It cannot change it.", kind: "words", default: "" },
      about("those files"),
    ],
  },
];

/** The feature of this name. */
export const featureNamed = (name: keyof Features): Feature => FEATURES.find((one) => one.name === name)!;

/** Whether this feature is on for an agent with these `features`: true, or its fields written out, unless it says false. */
export function featureOn(features: Features | undefined, name: keyof Features): boolean {
  const said = features?.[name];
  return said === undefined ? featureNamed(name).on : said !== false;
}

/** The fields `features.<name>` says, with every default filled in. Refused when one is not what its field takes. */
export function featureValues(features: Features | undefined, name: keyof Features, where = "features"): Record<string, unknown> {
  const feature = featureNamed(name);
  const said = features?.[name];
  return readOptions(feature.fields ?? [], typeof said === "object" ? said : undefined, `${where}.${name}`, true);
}

/** What each feature adds, made for one agent from its fields. */
const MAKERS: Record<keyof Features, (home: Home, values: Record<string, unknown>) => Tools> = {
  memory: (home) => memoryTools()(home),
  web: () => ({ webReadPage: readPage() }),
  selfImprovement: (home) => selfWriteTools()(home),
  runScripts: (home) => scriptTools()(home),
  memoryPerUser: () => userNotesTools()(),
  email: (_home, v) => {
    const search = v.search as string;
    const what = (v.about as string) || (search === "in:inbox" ? undefined : `mail matching ${search}`);
    const options = { search, days: v.days as number, what };
    const to = v.sendTo as string[];
    return {
      emailReadMail: gmail.readEmail(options),
      ...(v.reply ? { emailReplyMail: gmail.replyEmail(options) } : {}),
      ...(to.length
        ? { emailSendMail: gmail.sendEmail({ from: (v.sendFrom as string) || settings.connections.google.account, to, when: v.sendWhen as string }) }
        : {}),
    };
  },
  calendar: (_home, v) => {
    const calendars = v.calendars as string[];
    const what = (v.about as string) || undefined;
    return {
      calendarListEvents: calendar.listEvents({ calendars, days: v.days as number, what }),
      ...(v.add ? { calendarAddEvent: calendar.addEvent({ calendar: calendars[0] ?? "primary", what }) } : {}),
    };
  },
  drive: (_home, v) => {
    const search = v.search as string;
    const what = (v.about as string) || (search ? `Drive files matching ${search}` : "Drive");
    return { driveSearchFiles: drive.searchFiles({ search, what }), driveReadFile: drive.readFile({ search, what }) };
  },
};

/**
 * The tools a feature adds for this agent, from the fields `features` says.
 * With `preview`, from the fields that bring every tool, so the page can show
 * what switching it on, or filling its fields in, would add.
 */
export function featureToolSet(home: Home, name: keyof Features, features?: Features, preview = false): Tools {
  const feature = featureNamed(name);
  const values = featureValues(preview ? undefined : features, name);
  return MAKERS[name](home, preview ? { ...values, ...feature.preview } : values);
}

/**
 * What an agent's `features` turn on, as tools, under where each comes from,
 * like `features.memory`. A value that is not what its feature takes is
 * refused, and so is `runScripts` with nothing to run.
 */
export function featureTools(features: Features = {}, home: Home, where: string): Record<string, Tools> {
  for (const [name, value] of Object.entries(features)) {
    const feature = FEATURES.find((one) => one.name === name);
    if (!feature) throw new Error(`${where}: features has no ${name}. There are ${FEATURES.map((one) => one.name).join(", ")}.`);
    if (value === undefined || typeof value === "boolean") continue;
    if (!feature.fields) throw new Error(`${where}: features.${name} is true or false.`);
    featureValues(features, feature.name, `${where}: features`);
  }
  if (featureOn(features, "runScripts") && scriptsIn(home.folder).length === 0) {
    throw new Error(`${where} has features.runScripts on, and no scripts: neither ${home.folder}/scripts nor an executable file in a skill folder.`);
  }
  return Object.fromEntries(
    FEATURES.filter((one) => featureOn(features, one.name)).map((one) => [`features.${one.name}`, featureToolSet(home, one.name, features)]),
  );
}

export { defaultOf };
