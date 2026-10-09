// Saying whether one thing came out right, and counting what did not.
//
// This is what `@chloejs/core/test` means. It is its own file rather than part of
// ops/test/shared.ts because that starts the suite's stand-ins as it loads, and
// a test file that imported it to get these two would start them too.
//
// A job is code, so it is tested rather than scored. A test file sits beside
// the job it is about, is named `<job>.test.ts`, and runs its cases as it
// loads:
//
//   import { about, is } from "@chloejs/core/test";
//
//   about("what the nightly backup calls wrong");
//   is("a night like the last one says nothing", whatLooksWrong(tonight, good, 10), []);
//
// The runner finds it, so there is nothing to add anywhere else.

let failures = 0;

/** Prints a heading for the test cases that follow it, such as `about("what the nightly backup calls wrong")`. */
export function about(what: string): void {
  console.log(`\n${what}`);
}

/**
 * Checks one test case: prints `ok` if `got` equals `want`, or `FAIL` with
 * both values if not. `what` is the case's name. A failure is counted, and
 * makes `npm run test` fail. It does not throw.
 *
 * The two values are compared as JSON text, so two objects with the same
 * fields and values are equal. Watch out: the fields must be in the same
 * order, and fields set to `undefined` are ignored.
 */
export function is(what: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) return void console.log(`  ok   ${what}`);
  failures++;
  console.log(`  FAIL ${what}\n       got  ${a}\n       want ${b}`);
}

/** Returns how many `is` cases have failed so far, in every test file loaded. */
export function failed(): number {
  return failures;
}
