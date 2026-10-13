// Chloe's name, drawn in the terminal, with a few lines beside it. Printed at the
// top of setup and when the server starts in a terminal.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { accent, bold, dim, rgb } from "./style.ts";

/** One letter a pixel: # is lit, . is nothing. Seven rows tall, bottom aligned. */
const LETTERS: Record<string, string[]> = {
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  h: ["#....", "#....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  l: ["#", "#", "#", "#", "#", "#", "#"],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".####"],
};

const WORD = Array.from({ length: 8 }, (_, row) =>
  [..."Chloe"].map((letter) => LETTERS[letter]![row] ?? ".".repeat(LETTERS[letter]![0]!.length)).join("."),
);

const COLOUR = "#f7ecd8";

/**
 * The word as lines of text. Each character is two pixels, one above the other:
 * the top one in the foreground colour and the bottom one in its background.
 */
function word(): string[] {
  const lines: string[] = [];
  for (let row = 0; row < WORD.length; row += 2) {
    let line = "";
    for (let column = 0; column < WORD[row]!.length; column++) {
      const top = WORD[row]![column] === "#";
      const bottom = WORD[row + 1]?.[column] === "#";
      if (top && bottom) line += `${rgb(COLOUR, 38)}█\u001b[0m`;
      else if (top) line += `${rgb(COLOUR, 38)}▀\u001b[0m`;
      else if (bottom) line += `${rgb(COLOUR, 38)}▄\u001b[0m`;
      else line += " ";
    }
    lines.push(line);
  }
  return lines;
}

/** This package's version, from its package.json, found from here in the source and in dist/ alike. */
function version(): string {
  for (let folder = dirname(fileURLToPath(import.meta.url)); folder !== dirname(folder); folder = dirname(folder)) {
    const path = join(folder, "package.json");
    if (!existsSync(path)) continue;
    const read = JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
    if (read.name === "@chloejs/core") return read.version ?? "";
  }
  return "";
}

/**
 * "chloe" and its version, then `lines`, beside the name. With no colour (a
 * pipe, a journal, NO_COLOR) it is those lines alone, because the name is
 * nothing but colour.
 */
export function banner(lines: string[]): string {
  const title = `${bold(accent("chloe"))} ${dim(`v${version()}`)}`;
  const said = [title, ...lines];
  if (!process.stdout.isTTY || process.env.NO_COLOR) return `\n${said.join("\n")}\n`;
  const drawn = word();
  const first = Math.max(0, Math.floor((drawn.length - said.length) / 2));
  const rows = Math.max(drawn.length, first + said.length);
  const out: string[] = [];
  for (let at = 0; at < rows; at++) {
    out.push(`${drawn[at] ?? " ".repeat(WORD[0]!.length)}   ${said[at - first] ?? ""}`.trimEnd());
  }
  return `\n${out.join("\n")}\n`;
}
