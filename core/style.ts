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
