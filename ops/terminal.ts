// Asking a person something in a terminal: one line, a yes or no, one of a
// list, and the one password.
//
// Used by `npx chloe account` and `npx chloe setup`, which are the two commands
// a person runs by hand and the only two that ask anything.
//
// Nothing here imports a file that reads a setting as it loads, because setup
// runs before there is a chloe.config.ts to find, and reading a setting needs
// one.
import { accent, cyan, dim } from "#chloe/core/style";

/**
 * Whatever was typed past the end of the line just read, kept for the next
 * question. Piped input arrives as one chunk holding every answer at once, so a
 * reader that dropped the remainder would lose the second question's answer.
 */
let spare = "";

/** Set by `takeDefaults()`: every question is shown and answered with nothing typed. */
let unattended = false;

/**
 * From here on every question takes its default, as if Enter was pressed, and
 * nothing is read. For a run with nobody at a keyboard, which would otherwise
 * wait for ever on a read that never comes back.
 */
export function takeDefaults(): void {
  unattended = true;
}

/**
 * One line from the terminal. A hidden one is not printed back, so a password is
 * not left on the screen or in the scrollback. Read a character at a time rather
 * than with readline, because readline reads ahead and the next question would
 * find its answer already eaten.
 */
function line(question: string, hide: boolean): Promise<string> {
  process.stdout.write(question);
  if (unattended) {
    process.stdout.write("\n");
    return Promise.resolve("");
  }
  return new Promise((done, fail) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let said = "";

    function finish(error?: Error): void {
      input.off("data", more);
      input.off("end", ended);
      if (input.isTTY) input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write("\n");
      if (error) fail(error);
      else done(said.trim());
    }

    /** Takes one line out of `text`. True when it found the end of one. */
    function take(text: string): boolean {
      for (let at = 0; at < text.length; at++) {
        const one = text[at];
        if (one === "\r" || one === "\n") {
          spare = text.slice(at + 1).replace(/^\n/, "");
          return true;
        }
        if (one === "") throw new Error("Stopped.");
        if (one === "" || one === "\b") {
          said = said.slice(0, -1);
          if (!hide && input.isTTY) process.stdout.write("\b \b");
        } else {
          said += one;
          // Raw mode turns the terminal's own echo off, so an answer that is
          // meant to be seen has to be written back here.
          if (!hide && input.isTTY) process.stdout.write(one);
        }
      }
      return false;
    }

    function more(chunk: string): void {
      try {
        if (take(chunk)) finish();
      } catch (error) {
        finish(error as Error);
      }
    }

    // Input that ends with no answer, which is a command run with nobody at a
    // keyboard. Without this nothing is left to wait on and node exits halfway
    // through the question, saying nothing useful.
    function ended(): void {
      finish(new Error("Nothing was typed: there is no keyboard here. Run it in a terminal of your own."));
    }

    const held = spare;
    spare = "";
    try {
      if (take(held)) return void finish();
    } catch (error) {
      return void finish(error as Error);
    }

    if (input.readableEnded) return void ended();
    if (input.isTTY) input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", more);
    input.once("end", ended);
  });
}

/** One line, shown as typed. */
export function ask(question: string): Promise<string> {
  return line(question, false);
}

/** One line, not shown. */
export function askHidden(question: string): Promise<string> {
  return line(question, true);
}

/**
 * A yes or a no, asked again until it is one of them. Enter takes `unsaid`,
 * and the question ends saying which that is, as (Y/n) or (y/N).
 */
export async function yes(question: string, unsaid: boolean): Promise<boolean> {
  for (;;) {
    const said = (await line(`${question} ${dim(unsaid ? "(Y/n)" : "(y/N)")} `, false)).trim().toLowerCase();
    if (!said) return unsaid;
    if (["y", "yes"].includes(said)) return true;
    if (["n", "no"].includes(said)) return false;
    console.log("  y or n.");
  }
}

/** One line of a list to pick from. `above` is a line printed before it, for a group that starts there; "" is a blank line. */
export interface Choice<K extends string> {
  key: K;
  what: string;
  above?: string;
}

/**
 * One of a list, and returns the chosen entry's key. In a terminal it is a
 * list with an arrow on one line, moved with the arrow keys and taken with
 * Enter. Otherwise, which is piped answers or a run that takes every default,
 * it is numbered and asked again until the answer is one of them, and Enter
 * takes the first.
 */
export async function pick<K extends string>(question: string, options: Choice<K>[]): Promise<K> {
  if (process.stdin.isTTY && process.stdout.isTTY && !unattended && !spare) return await choose(question, options);
  const width = String(options.length).length;
  console.log(`${question}\n`);
  for (const [at, one] of options.entries()) {
    if (one.above !== undefined) console.log(one.above ? `\n  ${dim(one.above)}` : "");
    console.log(`  ${cyan(String(at + 1).padStart(width))}  ${one.what}`);
  }
  console.log();
  for (;;) {
    const said = (await line(`Which? ${dim(`(1-${options.length})`)} `, false)).trim();
    if (!said) return options[0].key;
    const at = Number(said);
    if (Number.isInteger(at) && at >= 1 && at <= options.length) return options[at - 1].key;
    console.log(`  a number from 1 to ${options.length}.`);
  }
}

/** How many rows of the terminal a line takes, once its colours are left out and it wraps. */
function rows(text: string): number {
  const width = text.replace(/\u001b\[[0-9;]*m/g, "").length;
  return Math.max(1, Math.ceil(width / (process.stdout.columns || 80)));
}

/**
 * The arrow list. It is drawn again on every key, over itself, and once one is
 * chosen only the question and the answer are left on the screen. Esc and
 * Ctrl+C stop, the same as Ctrl+C at a typed question.
 */
function choose<K extends string>(question: string, options: Choice<K>[]): Promise<K> {
  const out = process.stdout;
  const input = process.stdin;
  let at = 0;
  let drawn = 0;

  function draw(chosen: boolean): void {
    const lines = chosen
      ? [question, `${accent("❯")} ${accent(options[at].what)}`]
      : [
          question,
          "",
          ...options.flatMap((one, here) => [
            ...(one.above === undefined ? [] : one.above ? ["", `  ${dim(one.above)}`] : [""]),
            here === at ? `${accent("❯")} ${accent(one.what)}` : `  ${one.what}`,
          ]),
          "",
          dim("↑ ↓ to move · Enter to choose · Esc to stop"),
        ];
    // Back to the first row of the last drawing, and clear from there down.
    if (drawn) out.write(`\u001b[${drawn}F\u001b[0J`);
    out.write(`${lines.join("\n")}\n`);
    drawn = lines.reduce((sum, one) => sum + rows(one), 0);
  }

  return new Promise((done, fail) => {
    const wasRaw = input.isRaw;

    function finish(error?: Error): void {
      input.off("data", pressed);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      out.write("\u001b[?25h");
      if (error) fail(error);
      else done(options[at].key);
    }

    function pressed(chunk: string): void {
      // One chunk can hold several keys, as when one is held down.
      for (let from = 0; from < chunk.length; ) {
        const escape = chunk[from] === "\u001b" && "[O".includes(chunk[from + 1] ?? "");
        const key = escape ? chunk.slice(from, from + 3) : chunk[from]!;
        from += key.length;
        if (key === "\u001b[A" || key === "\u001bOA" || key === "k") at = (at + options.length - 1) % options.length;
        else if (key === "\u001b[B" || key === "\u001bOB" || key === "j") at = (at + 1) % options.length;
        else if (key === "\r" || key === "\n") {
          draw(true);
          return finish();
        } else if (key === "\u001b" || key === "\u0003") return finish(new Error("Stopped."));
        else continue;
        draw(false);
      }
    }

    out.write("\u001b[?25l");
    draw(false);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", pressed);
  });
}

/** How many names a typed word may match before the answer is "type more of one". */
const MOST = 25;

/** The names containing what was typed, case forgotten. */
export function containing(names: string[], said: string): string[] {
  const word = said.toLowerCase();
  return names.filter((one) => one.toLowerCase().includes(word));
}

/**
 * One of a list of names, found by typing part of one: one match is taken as
 * it is, several are listed to pick by number, and a word that matches none is
 * said and asked again. Enter takes `unsaid`.
 */
export async function pickNamed(question: string, names: string[], unsaid: string): Promise<string> {
  let word = "";
  for (;;) {
    if (!word) {
      const asked = (await ask(`${question} ${dim(`(${unsaid})`)} `)).trim();
      if (!asked) return unsaid;
      word = asked;
    }
    const said = word;
    word = "";
    const found = containing(names, said);
    if (found.length === 1) return found[0]!;
    if (!found.length) {
      console.log(`  None of the ${names.length} has "${said}" in its name.`);
      continue;
    }
    if (found.length > MOST) {
      console.log(`  ${found.length} of them have "${said}" in their name: type more of one.`);
      continue;
    }
    const width = String(found.length).length;
    found.forEach((one, at) => console.log(`  ${cyan(String(at + 1).padStart(width))}  ${one}`));
    const picked = (await ask(`Which? ${dim(`(1-${found.length})`)} `)).trim();
    if (!picked) return found[0]!;
    const at = Number(picked);
    if (Number.isInteger(at) && at >= 1 && at <= found.length) return found[at - 1]!;
    word = picked;
  }
}

/**
 * Sets the one password, asking for it twice or making one up. Says so when it
 * is replacing one, because that signs every browser out.
 *
 * Two that do not match, or one the login refuses as too short, are asked again
 * rather than thrown. Piped input has no second chance, so there it throws.
 *
 * The login is imported here rather than at the top of the file: it reaches the
 * state folder, which is found from chloe.config.ts, and this file is loaded
 * before there is one.
 */
export async function setPassword(): Promise<void> {
  const { firstPassword, hasPassword, ownName, resetPassword, suggestPassword } = await import("#chloe/serve/login");

  const already = hasPassword();
  if (already) {
    console.log("This copy already has a password, and this replaces it.");
    console.log("Nothing else changes: the agents, their runs, their memories and the tokens stay as they are.");
    console.log("Browsers signed in on the old one will have to sign in again.\n");
  }

  for (;;) {
    const typed = await askHidden("Password (leave blank for one made up here): ");
    const password = typed || suggestPassword();
    try {
      if (typed && typed !== (await askHidden("Again:    "))) throw new Error("Those two are not the same.");
      if (already) resetPassword(password);
      else firstPassword(password);
    } catch (error) {
      if (!process.stdin.isTTY) throw error;
      console.log(`  ${error instanceof Error ? error.message : String(error)} Again:\n`);
      continue;
    }

    // Somebody here because they forgot the password may have forgotten the name too.
    const name = ownName() ? ` and the name ${ownName()}` : "";
    if (typed) return void console.log(`\nDone. Sign in with it${name} at whatever serves the page.`);
    console.log(`\nYour password is  ${password}${name ? `, with the name ${ownName()}` : ""}\n`);
    console.log("Write it down. Only its hash is kept, so this is the one time it is shown.");
    return;
  }
}
