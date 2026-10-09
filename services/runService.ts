// Running one command on this machine.
//
// Nothing here ever takes a shell string. The caller builds its own argument
// list, so nothing a model says can be spliced into a command.
import { execFile } from "node:child_process";

/** What `run` returns when a program has finished. */
export interface Result {
  /**
   * The program's exit code. `0` means it worked.
   *
   * `127` means the program was not found. `1` is also used when the program
   * could not start, or was stopped because it ran too long.
   */
  exitCode: number;
  /** What the program printed. Cut after 80,000 characters. */
  stdout: string;
  /** What the program printed as errors. Cut after 80,000 characters. */
  stderr: string;
}

const MAX_OUTPUT = 80_000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n...[cut here, ${s.length} bytes in total]`
    : s;
}

/**
 * Runs one program on this machine and waits for it to finish.
 *
 * - `file`: the program, by name (found on the `PATH`) or by full path.
 * - `args`: the program's arguments, one string each.
 * - `options.timeoutMs`: how long it may run, in milliseconds. Default: 60000 (one minute).
 * - `options.cwd`: the folder it runs in. Default: the folder chloe runs in.
 * - `options.env`: extra environment variables. The program also gets all of chloe's own.
 *
 * It never uses a shell. Each argument reaches the program exactly as you
 * wrote it, so text from a model or a person cannot start a second command.
 *
 * Returns a `Result`. It does not throw when the program fails: check
 * `exitCode`. Each output is cut after 80,000 characters.
 */
export function run(
  file: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 1024 * 1024 * 16,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // execFile reports a missing binary as ENOENT, not as an exit code.
        // Turn it into 127, the shell's "command not found", so a caller can
        // tell "this program is not here" from "it ran and failed".
        const code = (error as NodeJS.ErrnoException | null)?.code;
        done({
          exitCode:
            typeof code === "number" ? code : code === "ENOENT" ? 127 : error ? 1 : 0,
          stdout: clip(stdout ?? ""),
          stderr: clip(stderr ?? "") || (code === "ENOENT" ? `${file}: not found` : ""),
        });
      },
    );
  });
}
