// Reading the markdown that agents are written in and answer in.
//
// A job or a skill is a markdown file that can open with a block of
// settings between two `---` lines (`cron:`, `name:`), known elsewhere as
// frontmatter. settingsAndBody() splits one into those settings and the words
// under them. prompt() points at such a file from code, and readPrompt()
// reads its words. oneLineSummary() does the other job: it turns a reply
// written in markdown into one plain line for the overview.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface MarkdownFile {
  /** What the block at the top says, `cron: "0 23 * * *"` read as { cron: "0 23 * * *" }. */
  settings: Record<string, string>;
  /** Everything under that block: the words themselves. */
  body: string;
}

// Not YAML on purpose: keys, one-line values, and `#` comments, nothing else.
export function settingsAndBody(text: string): MarkdownFile {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { settings: {}, body: text.trim() };

  const settings: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at === -1) continue;
    settings[trimmed.slice(0, at).trim()] = unquote(trimmed.slice(at + 1).trim());
  }
  return { settings, body: match[2].trim() };
}

function unquote(value: string): string {
  const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
  return quoted ? quoted[1] : value;
}

// Words kept in a markdown file, pointed at from code: an agent's instructions
// or a job's prompt. The path is inside the agent's folder, "instructions.md"
// or "jobs/morning-run.md", whichever file names it.

/**
 * Words kept in a markdown file, made with `prompt()`. chloe reads the file
 * when the agent loads, and again each time the file changes.
 */
export interface Prompt {
  /** The path of the markdown file, inside the agent's folder unless it is a full path. */
  file: string;
  /** Other files to add after the words, each wrapped in a tag named after its key. See `prompt()`. */
  include?: Record<string, string>;
}

/**
 * Points at words kept in a markdown file: an agent's `instructions`, or a
 * job's `markdown` prompt. The path is inside the agent's folder unless it is
 * a full path. If the file starts with a settings block between two `---`
 * lines, only the text under it is used.
 *
 * `include` adds other files after the words, each wrapped in a tag named
 * after its key. Use it for material the words are about that is kept
 * somewhere else:
 *
 * ```ts
 * prompt("instructions.md", { include: { cv: "/home/you/cv.md" } })
 * ```
 *
 * gives the words, then `<cv>`, the text of the file, and `</cv>`. Each key
 * must start with a letter and hold only letters, digits, `_` and `-`, like
 * `cv`. chloe watches these
 * files like the agent's own, so an edit takes effect within a second. If one
 * is missing, the agent does not load, and the error says which file.
 */
export function prompt(file: string, options: { include?: Record<string, string> } = {}): Prompt {
  for (const name of Object.keys(options.include ?? {})) {
    if (!/^[a-z][\w-]*$/i.test(name)) throw new Error(`prompt("${file}") includes a file as ${JSON.stringify(name)}, which is not a name for a tag. Use a word, like cv.`);
  }
  return { file, ...(options.include && { include: options.include }) };
}

/** The files a prompt includes, as full paths. */
export function includedIn(from: unknown, dir: string): string[] {
  return isPrompt(from) ? Object.values(from.include ?? {}).map((one) => resolve(dir, one)) : [];
}

/** Returns `true` if the value was made with `prompt()`, and `false` for anything else, such as words written as a plain string. */
export function isPrompt(value: unknown): value is Prompt {
  return typeof value === "object" && value !== null && typeof (value as Prompt).file === "string";
}

/**
 * The words themselves, from a plain string or from the file a marker names.
 * `where` is what to call the declaring file when something is wrong.
 */
export async function readPrompt(
  from: string | Prompt | undefined,
  options: { dir: string; where: string },
): Promise<string> {
  if (typeof from === "string") return from.trim();
  if (!isPrompt(from)) throw new Error(`${options.where} has no words. Give it a string or prompt("./name.md").`);

  const text = await readFile(resolve(options.dir, from.file), "utf8").catch(() => {
    throw new Error(`${options.where} points at ${JSON.stringify(from.file)}, which is not there.`);
  });
  // Only the body, so a file that kept a settings block at the top does not
  // read it out to a model as if it were instructions.
  const words = settingsAndBody(text).body;
  if (!words.trim()) throw new Error(`${options.where} points at ${JSON.stringify(from.file)}, which is empty.`);
  const included = await Promise.all(
    Object.entries(from.include ?? {}).map(async ([name, path]) => {
      const there = await readFile(resolve(options.dir, path), "utf8").catch(() => {
        throw new Error(`${options.where} includes ${path} as ${name}, which is not there.`);
      });
      return `<${name}>\n${there.trim()}\n</${name}>`;
    }),
  );
  return [words.trim(), ...included].join("\n\n");
}

/**
 * Turns the start of a markdown reply into one plain line. It removes list
 * marks, emphasis and heading marks, and joins the lines. If the line is
 * longer than `max` characters, it is cut and ends with `…`. Default `max`:
 * 200.
 *
 * It only shortens the text. It does not summarise what the text means.
 */
export function oneLineSummary(text: string, max = 200): string {
  const line = text
    .split(/\r?\n/)
    .map((one) => one.replace(/[*`#>]|__/g, "").replace(/^\s*(-|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
