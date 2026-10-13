// Words a terminal shows differently.
//
// Nothing is styled when the output is not a terminal (a pipe, a file, a
// service's journal) or NO_COLOR is set, so what gets written down stays plain.
// Each one ends only its own style, so one can sit inside another.
const ESC = "\u001b";

const plain = (): boolean => !process.stdout.isTTY || Boolean(process.env.NO_COLOR);

const style = (on: number, off: number) => (text: string): string => (plain() ? text : `${ESC}[${on}m${text}${ESC}[${off}m`);

export const bold = style(1, 22);

export const dim = style(2, 22);

/** A command to type. */
export const cyan = style(36, 39);

/** Something that worked. */
export const green = style(32, 39);

/** Something to fix later, which did not stop anything. */
export const yellow = style(33, 39);

/** Something that stopped what was going on. */
export const red = style(31, 39);

/**
 * An exact colour, as #rrggbb. Terminals that say they show any colour
 * (COLORTERM) get it as given; the rest get the nearest of the 256 nearly
 * every terminal has.
 */
export function rgb(hex: string, ground: 38 | 48): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  if (/truecolor|24bit/i.test(process.env.COLORTERM ?? "")) return `${ESC}[${ground};2;${r};${g};${b}m`;
  const step = (one: number) => Math.round((one / 255) * 5);
  return `${ESC}[${ground};5;${16 + 36 * step(r) + 6 * step(g) + step(b)}m`;
}

/** Chloe's green, the one on chloejs.org: the chosen line, and chloe's name. */
export const accent = (text: string): string => (plain() ? text : `${rgb("#6fbb9d", 38)}${text}${ESC}[39m`);
