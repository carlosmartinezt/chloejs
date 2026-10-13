// The abilities an agent can switch on: tools that chloe brings, each `true`
// or `false` in the agent's `abilities`, and a few with fields that say what
// they may reach. This is the one list: the loader adds each ability's tools
// from it, and the dashboard draws its switches and forms from it.
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute } from "node:path";

import { settings } from "#chloe/core/settings";
import { google } from "#chloe/connections/google/connection";
import * as calendar from "#chloe/connections/google/calendar";
import * as drive from "#chloe/connections/google/drive";
import * as gmail from "#chloe/connections/google/gmail";
import { resend } from "#chloe/connections/resend/connection";
import { sendEmail as resendSendEmail } from "#chloe/connections/resend/resend";
import type { Connection } from "#chloe/connections/connection";
import { folderTools } from "#chloe/model/tools/folders";
import { memoryTools, userNotesTools } from "#chloe/model/tools/memory";
import { scriptTools } from "#chloe/model/tools/script";
import { selfWriteTools } from "#chloe/model/tools/self";
import { readPage, search as searchWeb } from "#chloe/model/tools/web";
import type { Tools } from "#chloe/model/tool";
import { scriptsIn } from "#chloe/services/scriptsService";
import type { Home } from "./load.ts";
import { defaultOf, readOptions, type OptionSpec } from "./options.ts";

/**
 * Tools that chloe can add to an agent, each switched on or off with `true`
 * or `false`, for example `abilities: { scripts: true }`. A few take their
 * fields instead of `true`, like `googleMail: { search: "in:inbox", days: 3 }`;
 * the file says only what differs from the default. The page's Abilities view
 * switches them and fills the fields in, by changing this object in
 * `agent.ts`. `ABILITIES` is the list, with what each one is when unsaid.
 */
export interface Abilities {
  /**
   * Adds the memory tools: `memoryListFiles`, `memoryReadFile`,
   * `memorySearchFiles` and `memoryEditFile`. They work on
   * the agent's memory folder (see `memory` on the agent). On by default.
   */
  memory?: boolean;
  /**
   * Adds the tool `selfWriteFile`, which lets the agent change its own files:
   * its purpose, skills and jobs, and its code (`agent.ts`, jobs, tools,
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
   * (`ownListFiles`, `ownReadFile`) and its past runs (`ownListRuns`,
   * `ownReadRun`), and try one of its jobs (`ownTryJob`), in replies to its
   * owner. It does not need this setting for that.
   */
  selfImprovement?: boolean;
  /**
   * Adds the tools `webReadPage` (read one public web page as plain text) and
   * `webSearch` (search the web). Off by default. `webReadPage` reads only
   * public addresses and does not run the page's JavaScript. `webSearch` goes
   * to Brave Search when `connections.brave.api_key` is set, and to
   * DuckDuckGo when it is not. Switch the search tool off on its own to read
   * pages only.
   */
  web?: boolean;
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
  scripts?: boolean;
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
   * Adds the tools `folderListFiles`, `folderReadFile` and
   * `folderSearchFiles`, which read the folders named in `paths`, like a
   * project's code, and never write to them. Off by default, and adds nothing
   * until `paths` names a folder.
   *
   * The model names a folder by the last part of its path, so no two may end
   * the same. In a git repository, what git ignores is left out (`.env.local`,
   * `dist/`), and so is any `.env`, `.git`, `secrets` and `node_modules`
   * anywhere. A guest on a web channel gets them only if the channel names
   * them, like any other tool.
   */
  folders?: boolean | FoldersAbility;
  /**
   * Adds the tools that read the Gmail account Google is signed in to,
   * `emailReadMail`, and with the fields below, `emailReplyMail` and
   * `emailSendMail`. Off by default. `true` reads the inbox of the last 7
   * days and nothing else. Give fields to say which mail, and to let it reply
   * or send. Needs the Google sign-in.
   */
  googleMail?: boolean | GoogleMailAbility;
  /**
   * Adds the tool `calendarListEvents` for a Google calendar, and with
   * `add`, `calendarAddEvent`. Off by default. `true` reads the signed-in
   * account's own calendar for the next 7 days. Needs the Google sign-in.
   */
  googleCalendar?: boolean | GoogleCalendarAbility;
  /**
   * Adds the tools `driveSearchFiles` and `driveReadFile`, which find and read
   * files in Google Drive as text. Off by default. `true` reaches all of
   * Drive: give `search` to keep it to some files. Needs the Google sign-in.
   */
  googleDrive?: boolean | GoogleDriveAbility;
  /**
   * Adds the tool `resendSendEmail`, which sends one email through Resend to
   * people you name. Off by default, and adds nothing until `from` and `to`
   * are filled in. Needs `connections.resend.api_key`: without it nothing is
   * sent and nothing fails.
   */
  resend?: boolean | ResendAbility;
}

/** The fields of `abilities.folders`. */
export interface FoldersAbility {
  /** Full paths of the folders it may read, like `"/home/you/shop"`. Default: none, so it reads nothing. */
  paths?: string[];
  /** A few words for those folders, like `"the shop's code"`, said to the model. Default: their names. */
  about?: string;
}

/** The fields of `abilities.googleMail`. The model chooses only how far back and which listed message to answer. */
export interface GoogleMailAbility {
  /** A Gmail search that sets which mail the model can see, like `"in:inbox label:orders"`. It cannot change it. Default: `"in:inbox"`. */
  search?: string;
  /** How many days back it looks when it does not say. Default: 7. */
  days?: number;
  /** A few words for that mail, like `"order emails"`, said to the model. Default: none. */
  about?: string;
  /** The addresses it may write to. With any, it gets `emailSendMail`, which writes only the subject and the body. Default: none, so it cannot send. */
  sendTo?: string[];
  /** The From line it sends under, like `"Shop <you@gmail.com>"`. Default: the signed-in account. */
  sendFrom?: string;
  /** When it should send, in your words, said to the model. Default: "When asked to." */
  sendWhen?: string;
}

/** The fields of `abilities.googleCalendar`. */
export interface GoogleCalendarAbility {
  /** The ids of the calendars it can see; `"primary"` is the signed-in account's own. Default: `["primary"]`. */
  calendars?: string[];
  /** How many days ahead it looks when it does not say. Default: 7. */
  days?: number;
  /** A few words for those calendars, like `"the team calendar"`, said to the model. Default: none. */
  about?: string;
}

/** The fields of `abilities.googleDrive`. */
export interface GoogleDriveAbility {
  /** A Drive search that sets which files the model can see, like `"'folder-id' in parents"`. It cannot change it. Default: all of Drive. */
  search?: string;
  /** A few words for those files, like `"the shared proposals"`, said to the model. Default: none. */
  about?: string;
}

/** The fields of `abilities.resend`, the same shape as a bound Resend tool. */
export interface ResendAbility {
  /** The From line it sends under, like `"Shop <shop@example.com>"`. Must be on a domain set up in Resend. Required. */
  from?: string;
  /** The addresses it may write to. Required. */
  to?: string[];
  /** When it should send, in your words, said to the model. Required. */
  when?: string;
  /** The addresses a reply goes to. Empty: the `from` address. */
  replyTo?: string[];
  /** Put in front of every subject, `[tag]`, so an inbox can filter it. Default: none. */
  tag?: string;
  /** Send the body as HTML with a plain text copy. Default: off. */
  markdown?: boolean;
  /** A folder in its memory, like `"outbox"`, that gets a copy of each email sent. Default: none. */
  keep?: string;
}

/** One ability: what it is when unsaid, what it does in a line, the tools it adds and the fields it takes. */
export interface Ability {
  name: keyof Abilities;
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
  label: "Described as",
  about: `A few words for ${what}, said to the model. Optional.`,
  kind: "words",
  default: "",
});

/** Every ability, in the order the page shows them: self improvement first, then memory, scripts, notes per person and folders, then what reaches outside. A test holds `tools` to what each one adds. */
export const ABILITIES: Ability[] = [
  {
    name: "selfImprovement",
    label: "Self improvement",
    on: true,
    does: "Changes its own purpose, skills, jobs and code when you ask it to. Each change is a commit you can undo.",
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
    name: "scripts",
    label: "Scripts",
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
    name: "folders",
    label: "Folders",
    on: false,
    does: "Reads the folders you name, like a project's code, and never writes to them. What git ignores is left out.",
    tools: ["folderListFiles", "folderReadFile", "folderSearchFiles"],
    fields: [
      { name: "paths", label: "Folders", about: "Full paths of the folders it may read, like /home/you/shop. The model knows each by its last part.", kind: "list", default: [] },
      about("those folders"),
    ],
    preview: { paths: [tmpdir()] },
  },
  {
    name: "web",
    label: "Web",
    on: false,
    does: "Reads public web pages as plain text, and searches the web.",
    tools: ["webReadPage", "webSearch"],
  },
  {
    name: "googleMail",
    label: "Google Mail",
    on: false,
    does: "Reads the Gmail it may see, and can reply to it or write to people you name.",
    tools: ["emailReadMail", "emailReplyMail", "emailSendMail"],
    needs: google,
    fields: [
      { name: "search", label: "Mail it may read", about: "A Gmail search, like in:inbox label:orders. It cannot change it.", kind: "words", default: "in:inbox" },
      { name: "days", label: "Days back", about: "How far back it looks when it does not say.", kind: "number", default: 7 },
      about("that mail"),
      { name: "sendTo", label: "May write to", about: "Addresses it may send mail to. Empty: it cannot send.", kind: "list", default: [] },
      { name: "sendFrom", label: "Send as", about: "The From line, like Shop <you@gmail.com>. Empty: the signed-in account.", kind: "words", default: "" },
      { name: "sendWhen", label: "When to send", about: "When it should write, said to the model.", kind: "words", default: "When asked to." },
    ],
    preview: { sendTo: ["you@example.com"] },
  },
  {
    name: "googleCalendar",
    label: "Google Calendar",
    on: false,
    does: "Reads events on the Google calendars it may see, and can add one.",
    tools: ["calendarListEvents", "calendarAddEvent"],
    needs: google,
    fields: [
      { name: "calendars", label: "Calendars", about: "The ids of the calendars it may see. primary is the signed-in account's own.", kind: "list", default: ["primary"] },
      { name: "days", label: "Days ahead", about: "How far ahead it looks when it does not say.", kind: "number", default: 7 },
      about("those calendars"),
    ],
  },
  {
    name: "googleDrive",
    label: "Google Drive",
    on: false,
    does: "Finds and reads files in Google Drive as text.",
    tools: ["driveSearchFiles", "driveReadFile"],
    needs: google,
    fields: [
      { name: "search", label: "Files it may see", about: "A Drive search, like one folder. Empty: all of Drive. It cannot change it.", kind: "words", default: "" },
      about("those files"),
    ],
  },
  {
    name: "resend",
    label: "Send email (Resend)",
    on: false,
    does: "Sends one email through Resend to people you name. Nothing is sent without a key.",
    tools: ["resendSendEmail"],
    needs: resend,
    fields: [
      { name: "from", label: "Send as", about: "The From line, like Shop <shop@example.com>. Must be on a domain set up in Resend.", kind: "words", default: "", required: true },
      { name: "to", label: "May write to", about: "The addresses it may send to.", kind: "list", default: [], required: true },
      { name: "when", label: "When to send", about: "When it should write, said to the model.", kind: "words", default: "", required: true },
      { name: "replyTo", label: "Replies go to", about: "The addresses a reply goes to. Empty: the From line.", kind: "list", default: [] },
      { name: "tag", label: "Subject tag", about: "Put in front of every subject, like [orders], so an inbox can filter it.", kind: "words", default: "" },
      { name: "markdown", label: "Send as HTML", about: "Send the body as HTML with a plain text copy.", kind: "yesno", default: false },
      { name: "keep", label: "Keep a copy in", about: "A folder in its memory, like outbox, for a copy of each email sent.", kind: "words", default: "" },
    ],
    preview: { from: "you@example.com", to: ["you@example.com"], when: "When asked to." },
  },
];

/** The ability of this name. */
export const abilityNamed = (name: keyof Abilities): Ability => ABILITIES.find((one) => one.name === name)!;

/** Whether this ability is on for an agent with these `abilities`: true, or its fields written out, unless it says false. */
export function abilityOn(abilities: Abilities | undefined, name: keyof Abilities): boolean {
  const said = abilities?.[name];
  return said === undefined ? abilityNamed(name).on : said !== false;
}

/** The fields `abilities.<name>` says, with every default filled in. Refused when one is not what its field takes. */
export function abilityValues(abilities: Abilities | undefined, name: keyof Abilities, where = "abilities"): Record<string, unknown> {
  const ability = abilityNamed(name);
  const said = abilities?.[name];
  return readOptions(ability.fields ?? [], typeof said === "object" ? said : undefined, `${where}.${name}`, true);
}

/** What each ability adds, made for one agent from its fields. */
const MAKERS: Record<keyof Abilities, (home: Home, values: Record<string, unknown>) => Tools> = {
  memory: (home) => memoryTools()(home),
  selfImprovement: (home) => selfWriteTools()(home),
  web: () => ({ webReadPage: readPage(), webSearch: searchWeb() }),
  scripts: (home) => scriptTools()(home),
  memoryPerUser: () => userNotesTools()(),
  folders: (_home, v) => folderTools({ paths: v.paths as string[], about: (v.about as string) || undefined }),
  googleMail: (_home, v) => {
    const search = v.search as string;
    const what = (v.about as string) || (search === "in:inbox" ? undefined : `mail matching ${search}`);
    const options = { search, days: v.days as number, what };
    const to = v.sendTo as string[];
    return {
      emailReadMail: gmail.readEmail(options),
      emailReplyMail: gmail.replyEmail(options),
      ...(to.length
        ? { emailSendMail: gmail.sendEmail({ from: (v.sendFrom as string) || settings.connections.google.account, to, when: v.sendWhen as string }) }
        : {}),
    };
  },
  googleCalendar: (_home, v) => {
    const calendars = v.calendars as string[];
    const what = (v.about as string) || undefined;
    return {
      calendarListEvents: calendar.listEvents({ calendars, days: v.days as number, what }),
      calendarAddEvent: calendar.addEvent({ calendar: calendars[0] ?? "primary", what }),
    };
  },
  googleDrive: (_home, v) => {
    const search = v.search as string;
    const what = (v.about as string) || (search ? `Drive files matching ${search}` : "Drive");
    return { driveSearchFiles: drive.searchFiles({ search, what }), driveReadFile: drive.readFile({ search, what }) };
  },
  resend: (_home, v): Tools => {
    const from = v.from as string;
    const to = v.to as string[];
    const when = v.when as string;
    if (!from || to.length === 0 || !when) return {};
    const replyTo = v.replyTo as string[];
    return {
      resendSendEmail: resendSendEmail({
        from,
        to,
        when,
        ...(replyTo.length ? { replyTo } : {}),
        ...(v.tag ? { tag: v.tag as string } : {}),
        markdown: Boolean(v.markdown),
        ...(v.keep ? { keep: v.keep as string } : {}),
      }),
    };
  },
};

/**
 * The tools an ability adds for this agent, from the fields `abilities` says.
 * With `preview`, from the fields that bring every tool, so the page can show
 * what switching it on, or filling its fields in, would add.
 */
export function abilityToolSet(home: Home, name: keyof Abilities, abilities?: Abilities, preview = false): Tools {
  const ability = abilityNamed(name);
  const values = abilityValues(preview ? undefined : abilities, name);
  return MAKERS[name](home, preview ? { ...values, ...ability.preview } : values);
}

/**
 * What an agent's `abilities` turn on, as tools, under where each comes from,
 * like `abilities.memory`. A value that is not what its ability takes is
 * refused, and so is `scripts` with nothing to run.
 */
export function abilityTools(abilities: Abilities = {}, home: Home, where: string): Record<string, Tools> {
  for (const [name, value] of Object.entries(abilities)) {
    const ability = ABILITIES.find((one) => one.name === name);
    if (!ability) throw new Error(`${where}: abilities has no ${name}. There are ${ABILITIES.map((one) => one.name).join(", ")}.`);
    if (value === undefined || typeof value === "boolean") continue;
    if (!ability.fields) throw new Error(`${where}: abilities.${name} is true or false.`);
    abilityValues(abilities, ability.name, `${where}: abilities`);
  }
  if (abilityOn(abilities, "folders")) {
    const paths = abilityValues(abilities, "folders").paths as string[];
    for (const path of paths) {
      if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`${where}: abilities.folders names ${path}, which is not a folder. Give each one's full path.`);
      }
    }
    const twice = paths.map((path) => basename(path)).find((name, i, all) => all.indexOf(name) !== i);
    if (twice) throw new Error(`${where}: abilities.folders names two folders called ${twice}. The model knows each by its last part, so each must end differently.`);
  }
  if (abilityOn(abilities, "scripts") && scriptsIn(home.folder).length === 0) {
    throw new Error(`${where} has abilities.scripts on, and no scripts: neither ${home.folder}/scripts nor an executable file in a skill folder.`);
  }
  return Object.fromEntries(
    ABILITIES.filter((one) => abilityOn(abilities, one.name)).map((one) => [`abilities.${one.name}`, abilityToolSet(home, one.name, abilities)]),
  );
}

export { defaultOf };
