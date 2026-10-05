// A program a connector needs, which the person installs. Nothing here
// downloads one.
import { run } from "#chloe/services/runService";

export interface Program {
  /** Its name on the PATH. */
  name: string;
  /** The oldest version that works, as three numbers. */
  least: string;
  /** The setting that may name it as a path instead. */
  setting: string;
  /** How to install it, in words: a command, or where to get it. */
  install: string;
}

/** What `<program> --version` prints, as three numbers, or nothing when it does not run. */
async function version(program: string): Promise<number[] | undefined> {
  const result = await run(program, ["--version"], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return undefined;
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : undefined;
}

function older(has: number[], wants: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((has[i] ?? 0) !== (wants[i] ?? 0)) return (has[i] ?? 0) < (wants[i] ?? 0);
  }
  return false;
}

/**
 * The program to run: `named`, which is the program's setting, else its name
 * on the PATH. Thrown when there is none new enough, saying what was found and
 * what to install.
 */
export async function findProgram(program: Program, named: string): Promise<string> {
  const wants = program.least.split(".").map(Number);
  const path = named || program.name;
  const has = await version(path);
  if (has && !older(has, wants)) return path;
  const found = named
    ? `${program.setting} is ${JSON.stringify(named)}, which ${has ? `is ${program.name} ${has.join(".")}` : "does not run"}`
    : has
      ? `The ${program.name} on the PATH is ${has.join(".")}`
      : `${program.name} is not installed`;
  throw new Error(
    `${found}, and this needs ${program.name} ${program.least} or newer. ${program.install}, then put it on the ` +
      `PATH or set ${program.setting} to where it is.`,
  );
}
