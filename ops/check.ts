// Saying whether one thing came out right, and counting what did not.
//
// This is what `@chloejs/core/test` means. It is its own file rather than part of
// test.ts because test.ts runs its cases as it loads, and a test file that
// imported it to get these two would run the whole suite again.
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

/** The heading a group of cases runs under. */
export function about(what: string): void {
  console.log(`\n${what}`);
}

/** Compared as JSON, so two objects of the same shape are the same answer. */
export function is(what: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) return void console.log(`  ok   ${what}`);
  failures++;
  console.log(`  FAIL ${what}\n       got  ${a}\n       want ${b}`);
}

/** How many cases failed, across every file the runner loaded. */
export function failed(): number {
  return failures;
}
