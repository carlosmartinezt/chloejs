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

/** Words in a file, read when they are needed rather than as the agent loads. */
export interface Prompt {
  file: string;
}

/**
 * Declares words in a markdown file inside the agent's folder: its
 * instructions, or a job's prompt.
 */
export function prompt(file: string): Prompt {
  return { file };
}

/** Whether a value is a declared prompt rather than words written inline. */
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
  return words;
}

/**
 * The start of a reply as one plain line: list marks, emphasis and headings
 * gone, lines joined, cut at `max`. It is how the reply begins, not what it
 * means: nothing here reads it.
 */
export function oneLineSummary(text: string, max = 200): string {
  const line = text
    .split(/\r?\n/)
    .map((one) => one.replace(/[*`#>]|__/g, "").replace(/^\s*(-|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
