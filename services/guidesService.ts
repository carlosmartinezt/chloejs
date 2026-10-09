// The guides for the version of chloe that is running, as an agent reads them
// to learn what it can be given: a connection, a channel, a feature, a job.
// They are docs/ in a clone and dist/docs/ in the package, the same place
// relative to this file in both.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUIDES = fileURLToPath(new URL("../docs", import.meta.url));

/** Every guide, by the name readGuide takes, with the one line that says what it covers. */
export function listGuides(): { page: string; about: string }[] {
  if (!existsSync(GUIDES)) return [];
  return readdirSync(GUIDES)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => {
      const text = readFileSync(join(GUIDES, file), "utf8");
      // The built page says it as "> ...", the source as "summary: ...".
      const about = /^(?:> |summary: )(.+)$/m.exec(text)?.[1] ?? "";
      return { page: basename(file, ".md"), about };
    });
}

/** One guide, whole, by its name from listGuides, like "connections". */
export function readGuide(page: string): string {
  const name = basename(page.replace(/\.md$/, ""));
  const path = join(GUIDES, `${name}.md`);
  if (!existsSync(path)) throw new Error(`There is no guide called ${page}. The guides are: ${listGuides().map((one) => one.page).join(", ")}.`);
  return readFileSync(path, "utf8");
}
