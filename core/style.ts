// Words a terminal shows differently.
//
// Nothing is styled when the output is not a terminal (a pipe, a file, a
// service's journal) or NO_COLOR is set, so what gets written down stays plain.
const ESC = "\u001b";

const plain = (): boolean => !process.stdout.isTTY || Boolean(process.env.NO_COLOR);

export const bold = (text: string): string => (plain() ? text : `${ESC}[1m${text}${ESC}[0m`);

export const dim = (text: string): string => (plain() ? text : `${ESC}[2m${text}${ESC}[0m`);
