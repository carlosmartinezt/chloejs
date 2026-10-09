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

import { memoryDir, memoryFolderOf } from "./paths.ts";

/**
 * A small JSON file an agent keeps in its memory, read with a zod schema.
 * Made by `note()`.
 */
export interface Note<T> {
  /** The full path of the file. */
  path: string;
  /**
   * Reads the file and checks it with the schema. If the schema ends in
   * `.catch(...)`, a missing or broken file gives that default value.
   * Without it, a missing or broken file throws.
   */
  read(): Promise<T>;
  /**
   * Writes `value` as the whole file, and returns it. The old file is
   * replaced in one step, so a reader never sees half a file. Makes the
   * folder if it is missing.
   */
  write(value: T): Promise<T>;
}

/**
 * Returns a small JSON file, `<name>.json`, in the memory folder of the agent
 * with the id `agent`. Use it for something a job needs to remember until its
 * next run.
 *
 * `shape` is the zod schema the file is read with. End it with
 * `.catch(...)`, so a file that is missing or broken reads as that default
 * value and does not stop the run.
 *
 * @example
 * const seen = note("shop", "seen-orders", z.object({ ids: z.array(z.string()) }).catch({ ids: [] }));
 * const { ids } = await seen.read();
 * await seen.write({ ids: [...ids, "A-1001"] });
 */
export function note<T>(agent: string, name: string, shape: z.ZodType<T>): Note<T> {
  const path = join(memoryFolderOf(agent), `${name}.json`);
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
