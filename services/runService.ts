// Running one command on this machine.
//
// Nothing here ever takes a shell string. The caller builds its own argument
// list, so nothing a model says can be spliced into a command.
import { execFile } from "node:child_process";

/** What a command came back with. */
export interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 80_000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n...[cut here, ${s.length} bytes in total]`
    : s;
}

/**
 * Runs one command with its arguments, never through a shell, and cuts output
 * that is very long.
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
