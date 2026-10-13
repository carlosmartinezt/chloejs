// Chloe's hat, drawn in the terminal, with a few lines beside it. Printed at the
// top of setup and when the server starts in a terminal.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { accent, bold, dim, rgb } from "./style.ts";

/** One letter a pixel: c the hat, g the ribbon, h the hair, . nothing. Two rows make one line of text. */
const HAT = [
  "......cccccc......",
  ".....cccccccc.....",
  ".gg..cccccccc.....",
  "..ggggggggggg.....",
  ".gg.gcccccccc.....",
  ".cccgcccccccccccc.",
  "ccccccccccccccccc.",
  "..hhhh.......hhhh.",
  ".hhhh.........hhh.",
  ".hh............hhh",
];

const COLOURS: Record<string, string> = { c: "#f7ecd8", g: "#4a9d5b", h: "#1d7a5c" };

/**
 * The hat as lines of text. Each character is two pixels, one above the other:
 * the top one in the character's colour and the bottom one in its background.
 */
function hat(): string[] {
  const lines: string[] = [];
  for (let row = 0; row < HAT.length; row += 2) {
    let line = "";
    for (let column = 0; column < HAT[row]!.length; column++) {
      const top = COLOURS[HAT[row]![column]!];
      const bottom = COLOURS[HAT[row + 1]?.[column] ?? "."];
      if (!top && !bottom) line += " ";
      else if (!top) line += `${rgb(bottom!, 38)}▄\u001b[0m`;
      else if (!bottom) line += `${rgb(top, 38)}▀\u001b[0m`;
      else if (top === bottom) line += `${rgb(top, 38)}█\u001b[0m`;
      else line += `${rgb(top, 38)}${rgb(bottom, 48)}▀\u001b[0m`;
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
 * "chloe" and its version, then `lines`, beside the hat. With no colour (a
 * pipe, a journal, NO_COLOR) it is those lines alone, because the hat is
 * nothing but colour.
 */
export function banner(lines: string[]): string {
  const title = `${bold(accent("chloe"))} ${dim(`v${version()}`)}`;
  const said = [title, ...lines];
  if (!process.stdout.isTTY || process.env.NO_COLOR) return `\n${said.join("\n")}\n`;
  const drawn = hat();
  const first = Math.max(0, Math.floor((drawn.length - said.length) / 2));
  const rows = Math.max(drawn.length, first + said.length);
  const out: string[] = [];
  for (let at = 0; at < rows; at++) {
    out.push(`${drawn[at] ?? " ".repeat(HAT[0]!.length)}   ${said[at - first] ?? ""}`.trimEnd());
  }
  return `\n${out.join("\n")}\n`;
}
