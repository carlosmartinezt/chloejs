// Taking plugins out of this repo, and checking that any of them can be.
//
//   npm run plugins -- remove google telegram   takes them out of this repo, in place
//   npm run check:plugins                       a copy without every plugin, and one
//                                               without each, type checked, built and tested
//   npm run check:plugins -- google             only those
//
// Taking one out is deleting its folder and its lines in plugins/index.ts, in
// the entrance files that publish its names, in package.json's exports and in
// site/plugins.ts. This does exactly that, so the check takes them out the way
// a person would. It works on this repo, not on a project that installed chloe.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL("..", import.meta.url));

/** The files that publish a plugin's names, besides the two lists. */
const ENTRANCES = ["index.ts", "services/index.ts", "channels/index.ts", "connections/index.ts"];

/** Every plugin in a repo, by its folder's name. */
function pluginsIn(root: string): string[] {
  return readdirSync(join(root, "plugins"), { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => one.name).sort();
}

const edit = (file: string, change: (text: string) => string) => writeFileSync(file, change(readFileSync(file, "utf8")));
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Takes one plugin out of the repo at `root`: its folder, and its lines everywhere it is named. */
export function remove(root: string, name: string): void {
  if (!existsSync(join(root, "plugins", name))) throw new Error(`There is no plugin called ${name}. There are ${pluginsIn(root).join(", ")}.`);
  rmSync(join(root, "plugins", name), { recursive: true });

  edit(join(root, "plugins/index.ts"), (text) => {
    const line = new RegExp(`import \\{ (\\w+) \\} from "\\./${escaped(name)}/plugin\\.ts";\\n`).exec(text);
    if (!line) throw new Error(`plugins/index.ts does not import ${name}/plugin.ts, so its lines there were left alone.`);
    const without = (list: string) => list.split(", ").filter((one) => one && one !== line[1]).join(", ");
    return text
      .replace(line[0], "")
      .replace(/(= \[)([^\]]*)(\];)/, (_all, open: string, list: string, close: string) => open + without(list) + close)
      .replace(/(export \{ )([^}]*)( \};)/, (_all, open: string, list: string, close: string) => open + without(list) + close);
  });

  for (const entrance of ENTRANCES) {
    edit(join(root, entrance), (text) => text.split("\n").filter((line) => !line.includes(`#chloe/plugins/${name}/`)).join("\n"));
  }

  edit(join(root, "package.json"), (text) => {
    const manifest = JSON.parse(text) as { exports: Record<string, { "chloe-source"?: string }> };
    for (const [key, entrance] of Object.entries(manifest.exports)) {
      if (entrance["chloe-source"]?.startsWith(`./plugins/${name}/`)) delete manifest.exports[key];
    }
    return `${JSON.stringify(manifest, null, 2)}\n`;
  });

  edit(join(root, "site/plugins.ts"), (text) => {
    const line = new RegExp(`import \\{ (\\w+) \\} from "\\.\\./plugins/${escaped(name)}/[^"]+";\\n`).exec(text);
    if (!line) return text;
    return text.replace(line[0], "").split("\n").filter((one) => !new RegExp(`^\\s+[\\w"-]+: ${line[1]},$`).test(one)).join("\n");
  });
}

/** A copy of this repo with these plugins taken out, its node_modules this one's. */
function copyWithout(names: string[]): string {
  const to = mkdtempSync(join(tmpdir(), "chloe-without-"));
  const left = new Set(["node_modules", "dist", "data", ".git"].map((one) => join(HERE, one)));
  left.add(join(HERE, "example/data"));
  cpSync(HERE, to, { recursive: true, filter: (from) => !left.has(from) });
  symlinkSync(join(HERE, "node_modules"), join(to, "node_modules"));
  for (const name of names) remove(to, name);
  return to;
}

/** What failed in a copy without these plugins, in a line each, or nothing when all of it passed. */
function failures(names: string[]): string[] {
  const at = copyWithout(names);
  const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: at, encoding: "utf8", maxBuffer: 64 << 20 });
  const found: string[] = [];
  try {
    // The example is a project using chloe, and uses what it uses: Telegram, the
    // web channel and Gmail among them, so it is left out of this.
    const types = `${run("npx", ["tsc", "--noEmit", "-p", "."]).stdout}${run("npx", ["tsc", "--noEmit", "-p", "site"]).stdout}`
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("example/"));
    found.push(...types.slice(0, 10));
    const page = run("npm", ["run", "build:site"]);
    if (page.status !== 0) found.push(`the page does not build: ${page.stderr.trim().split("\n").at(-1)}`);
    const tests = run(process.execPath, ["--conditions=chloe-source", "ops/test.ts"]);
    if (tests.status !== 0) {
      const lines = `${tests.stdout}${tests.stderr}`.split("\n");
      const failing = lines.filter((line) => line.startsWith("  FAIL"));
      found.push(...(failing.length ? failing : [lines.filter(Boolean).slice(-6).join(" / ")]));
    }
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
  return found;
}

/** Checks a copy without every plugin, then one without each of `names`. One at a time: the tests use fixed ports. */
function check(names: string[]): boolean {
  let ok = true;
  for (const without of [pluginsIn(HERE), ...names.map((one) => [one])]) {
    const said = without.length > 1 ? "without every plugin" : `without ${without[0]}`;
    const began = Date.now();
    const found = failures(without);
    console.log(`${found.length ? "FAIL" : "ok  "} ${said} (${Math.round((Date.now() - began) / 1000)}s)`);
    for (const line of found) console.log(`       ${line}`);
    ok &&= found.length === 0;
  }
  return ok;
}

// Run as a command, and not when a test imports `remove`.
const [what, ...names] = process.argv[1] === fileURLToPath(import.meta.url) ? process.argv.slice(2) : ["imported"];
if (what === "imported") {
  // Nothing to do.
} else if (what === "remove") {
  if (!names.length) throw new Error("Say which plugins to take out, like: npm run plugins -- remove google");
  for (const name of names) remove(HERE, name);
  execFileSync("git", ["status", "--short"], { cwd: HERE, stdio: "inherit" });
  console.log(
    `\nTook out ${names.join(", ")}. A config that still sets one of their settings, or an agent that names one of their abilities or channels, is now refused saying so: take those lines out. The guides in docs/ that describe them are still there.`,
  );
} else if (what === "check") {
  const unknown = names.find((one) => !pluginsIn(HERE).includes(one));
  if (unknown) throw new Error(`There is no plugin called ${unknown}. There are ${pluginsIn(HERE).join(", ")}.`);
  process.exit(check(names.length ? names : pluginsIn(HERE)) ? 0 : 1);
} else {
  console.log("npm run plugins -- remove <plugin...>   takes plugins out of this repo\nnpm run check:plugins [-- <plugin...>]   checks that each can be taken out");
}
