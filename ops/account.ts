// Making the one account, from a shell on the box that runs chloe.
//
//   npm run account            asks for a username and a password
//   npm run account carlos     asks for the password only
//
// There used to be a setup form on the first visit. There is no page on this
// port any more, so the first account is made here instead, which is better
// anyway: it takes a shell rather than whoever reaches the address first.
//
// Changing the account later means deleting data/login.json and running this
// again, which is deliberate and takes the same shell.
import { createAccount, hasAccount } from "#chloe/serve/login.ts";

if (hasAccount()) {
  console.error("There is already an account. To change it, delete data/login.json and run this again.");
  process.exit(1);
}

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

const username = process.argv[2] ?? (await line("Username: ", false));
const password = await line("Password: ", true);
const again = await line("Again:    ", true);

if (password !== again) {
  console.error("Those two are not the same.");
  process.exit(1);
}

try {
  createAccount(username, password);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`\nDone. ${username} can sign in at whatever serves the page.`);
