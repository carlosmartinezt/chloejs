// The plugins: each folder under plugins/ is on the list, and nothing outside
// a plugin's folder imports from it except the list and the files that say
// what the package publishes, so taking one out is deleting its folder and
// its lines in those.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { about, is } from "#chloe/ops/check";

{
  about("plugins");
  const { PLUGINS } = await import("#chloe/plugins/index");
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const plugins = join(root, "plugins");
  const folders = readdirSync(plugins, { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => one.name);
  is("each folder in plugins/ is on the list, by its name", PLUGINS.map((one) => one.name).sort(), folders.sort());

  // The two lists, the runtime's and the page's, and the entrances: what a plugin publishes is named there.
  const LISTS = ["plugins/index.ts", "site/plugins.ts", "index.ts", "services/index.ts", "channels/index.ts", "connections/index.ts"];
  const skipped = new Set(["node_modules", "dist", "data", ".git", "page"]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const one of readdirSync(dir, { withFileTypes: true })) {
      if (one.isDirectory() && !skipped.has(one.name)) walk(join(dir, one.name));
      else if (one.isFile() && /\.(ts|tsx)$/.test(one.name)) files.push(join(dir, one.name));
    }
  };
  walk(root);

  const pluginOf = (path: string): string | undefined => {
    const inside = relative(plugins, path);
    return inside.startsWith("..") || !inside.includes(sep) ? undefined : inside.split(sep)[0];
  };
  const reaching: string[] = [];
  for (const file of files) {
    const own = pluginOf(file);
    // This file writes those lists out as samples, below.
    if (LISTS.some((one) => file === join(root, one)) || file === fileURLToPath(import.meta.url)) continue;
    for (const [, named] of readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
      const target = named.startsWith("#chloe/") ? join(root, named.slice("#chloe/".length)) : named.startsWith(".") ? resolve(dirname(file), named) : undefined;
      const plugin = target && pluginOf(target);
      if (plugin && plugin !== own) reaching.push(`${relative(root, file)} imports ${named}`);
    }
  }
  is("nothing outside a plugin's folder imports from it but the list and the entrances", reaching, []);
}

{
  about("taking a plugin out");
  const { mkdirSync, mkdtempSync, writeFileSync: put, readFileSync: get, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { remove } = await import("#chloe/ops/plugins");
  // A repo with the lists and nothing else, so this runs in no time. `npm run
  // check:plugins` takes plugins out of a whole copy and tests what is left.
  const root = mkdtempSync(join(tmpdir(), "chloe-remove-"));
  for (const one of ["plugins/mail", "plugins/chat", "services", "channels", "connections", "site"]) mkdirSync(join(root, one), { recursive: true });
  put(join(root, "plugins/mail/plugin.ts"), "");
  put(join(root, "plugins/chat/plugin.ts"), "");
  put(join(root, "plugins/index.ts"), 'import { chat } from "./chat/plugin.ts";\nimport { mail } from "./mail/plugin.ts";\n\nexport const PLUGINS: Plugin[] = [mail, chat];\n\nexport { chat, mail };\n');
  put(join(root, "index.ts"), "");
  put(join(root, "services/index.ts"), 'export { send } from "#chloe/plugins/mail/send";\nexport { run } from "./run.ts";\n');
  put(join(root, "channels/index.ts"), 'export { chatChannel } from "#chloe/plugins/chat/chat";\n');
  put(join(root, "connections/index.ts"), "");
  put(join(root, "package.json"), JSON.stringify({ exports: { ".": { "chloe-source": "./index.ts" }, "./tools/mail": { "chloe-source": "./plugins/mail/tools.ts" } } }));
  put(join(root, "site/plugins.ts"), 'import { MailSetup } from "../plugins/mail/page/MailSetup.tsx";\n\nexport const PANELS = {\n  mail: MailSetup,\n};\n');
  remove(root, "mail");
  is("its folder is gone", existsSync(join(root, "plugins/mail")), false);
  is("and its lines in the list", get(join(root, "plugins/index.ts"), "utf8"), 'import { chat } from "./chat/plugin.ts";\n\nexport const PLUGINS: Plugin[] = [chat];\n\nexport { chat };\n');
  is("and in the entrances, the others left alone", get(join(root, "services/index.ts"), "utf8"), 'export { run } from "./run.ts";\n');
  is("and its entrances in package.json", Object.keys(JSON.parse(get(join(root, "package.json"), "utf8")).exports), ["."]);
  is("and its part of the page", get(join(root, "site/plugins.ts"), "utf8"), "\nexport const PANELS = {\n};\n");
  is("a plugin that is not there is refused, saying which there are", (() => { try { remove(root, "mail"); return ""; } catch (error) { return (error as Error).message; } })(), "There is no plugin called mail. There are chat.");
}
