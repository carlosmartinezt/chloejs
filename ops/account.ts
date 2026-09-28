// The one password, set from a shell on the box that runs chloe.
//
//   npx chloe account     asks for a password, or makes one up if none is typed
//
// Run again later and it sets a new one, which is the way back in from a
// forgotten password. It takes a shell rather than an address, so nobody who
// only reaches the port can do it.
import { createAccount, hasAccount, resetPassword, suggestPassword } from "#chloe/serve/login";

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

const already = hasAccount();
if (already) {
  console.log("This copy already has a password, and this replaces it.");
  console.log("Nothing else changes: the agents, their runs, their memories and the tokens stay as they are.");
  console.log("Browsers signed in on the old one will have to sign in again.\n");
}

const typed = await line("Password (leave blank for one made up here): ", true);
let password = typed;

if (typed) {
  const again = await line("Again:    ", true);
  if (typed !== again) {
    console.error("Those two are not the same.");
    process.exit(1);
  }
} else {
  password = suggestPassword();
}

try {
  if (already) resetPassword(password);
  else createAccount(password);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

if (typed) console.log(`\nDone. Sign in with it at whatever serves the page.`);
else {
  console.log(`\nYour password is  ${password}\n`);
  console.log("Write it down. Only its hash is kept, so this is the one time it is shown.");
}
