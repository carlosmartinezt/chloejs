// A small JSON file one agent writes and reads back next time.
//
// The shape is a zod schema ending in `.catch(...)`, so a missing file and an
// unreadable one both come back as the default rather than stopping the run.
// That forgiveness is why the write has to be atomic: two jobs can want the
// same note at the same moment, one writing and one reading, and a reader that
// caught half a file would not fail. It would quietly get the default and
// report on an empty world.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { z } from "zod";

import { STATE } from "./paths.ts";

/** One JSON file an agent keeps, read and written against a schema. */
export interface Note<T> {
  path: string;
  read(): Promise<T>;
  write(value: T): Promise<T>;
}

/**
 * A note by name, in that agent's own state folder. A shape with a `catch`
 * makes a note that is not there read as its default.
 */
export function note<T>(agent: string, name: string, shape: z.ZodType<T>): Note<T> {
  const path = join(STATE, agent, `${name}.json`);
  return {
    path,
    async read() {
      return shape.parse(await readFile(path, "utf8").then(JSON.parse).catch(() => undefined));
    },
    async write(value) {
      await mkdir(dirname(path), { recursive: true });
      // Beside the note, so the rename stays on one filesystem and is atomic:
      // a reader sees the whole of the old file or the whole of the new one.
      const part = `${path}.${process.pid}.part`;
      await writeFile(part, JSON.stringify(value, null, 2));
      await rename(part, path);
      return value;
    },
  };
}
