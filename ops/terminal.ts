// Asking a person something in a terminal: one line, a yes or no, one of a
// list, and the one password.
//
// Used by `npx chloe account` and `npx chloe setup`, which are the two commands
// a person runs by hand and the only two that ask anything.
//
// Nothing here imports the rest of the runtime as it loads, because setup runs
// before there is a chloe.config.ts to find, and every file that reads a
// setting needs one.

/**
 * Whatever was typed past the end of the line just read, kept for the next
 * question. Piped input arrives as one chunk holding every answer at once, so a
 * reader that dropped the remainder would lose the second question's answer.
 */
let spare = "";

/**
 * One line from the terminal. A hidden one is not printed back, so a password is
 * not left on the screen or in the scrollback. Read a character at a time rather
 * than with readline, because readline reads ahead and the next question would
 * find its answer already eaten.
 */
function line(question: string, hide: boolean): Promise<string> {
  process.stdout.write(question);
  return new Promise((done, fail) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let said = "";

    function finish(error?: Error): void {
      input.off("data", more);
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

    const held = spare;
    spare = "";
    try {
      if (take(held)) return void finish();
    } catch (error) {
      return void finish(error as Error);
    }

    if (input.isTTY) input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", more);
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
 * which is why the question says which that is.
 */
export async function yes(question: string, unsaid: boolean): Promise<boolean> {
  for (;;) {
    const said = (await line(`${question} `, false)).trim().toLowerCase();
    if (!said) return unsaid;
    if (["y", "yes"].includes(said)) return true;
    if (["n", "no"].includes(said)) return false;
    console.log("  y or n.");
  }
}

/**
 * One of a numbered list, asked again until it is one of them. Returns the
 * chosen entry's key, and Enter takes the first.
 */
export async function pick<K extends string>(question: string, options: { key: K; what: string }[]): Promise<K> {
  console.log(question);
  options.forEach((one, at) => console.log(`  ${at + 1}  ${one.what}`));
  for (;;) {
    const said = (await line(`Which? (1-${options.length}) `, false)).trim();
    if (!said) return options[0].key;
    const at = Number(said);
    if (Number.isInteger(at) && at >= 1 && at <= options.length) return options[at - 1].key;
    console.log(`  a number from 1 to ${options.length}.`);
  }
}

/**
 * Sets the one password, asking for it twice or making one up. Says so when it
 * is replacing one, because that signs every browser out.
 *
 * Two that do not match, or one the login refuses as too short, are asked again
 * rather than thrown: this is the last question setup asks, and a throw here
 * would end a run that had already written everything else. Piped input has no
 * second chance, so there it throws.
 *
 * The login is imported here rather than at the top of the file: it reaches the
 * database, which is found from chloe.config.ts, and setup calls this having
 * only just written that file.
 */
export async function setPassword(): Promise<void> {
  const { createAccount, hasAccount, resetPassword, suggestPassword } = await import("#chloe/serve/login");

  const already = hasAccount();
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
      else createAccount(password);
    } catch (error) {
      if (!process.stdin.isTTY) throw error;
      console.log(`  ${error instanceof Error ? error.message : String(error)} Again:\n`);
      continue;
    }

    if (typed) return void console.log(`\nDone. Sign in with it at whatever serves the page.`);
    console.log(`\nYour password is  ${password}\n`);
    console.log("Write it down. Only its hash is kept, so this is the one time it is shown.");
    return;
  }
}
