// The abilities an agent can switch on: tools that chloe brings, each `true`
// or `false` in the agent's `abilities`, and a few with fields that say what
// they may reach. This is the one list: the loader adds each ability's tools
// from it, and the dashboard draws its switches and forms from it.

import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute } from "node:path";

import type { Connection } from "#chloe/connections/connection";
import { folderTools } from "#chloe/model/tools/folders";
import { scriptTools } from "#chloe/model/tools/script";
import type { Tools } from "#chloe/model/tool";
import { PLUGINS } from "#chloe/plugins/index";
// Kept in the published types, which drop the line above, so what each plugin adds to `Abilities` is there.
import "#chloe/plugins/index";
import { scriptsIn } from "#chloe/services/scriptsService";
import type { Home } from "./load.ts";
import { about, defaultOf, readOptions, type OptionSpec } from "./options.ts";

/**
 * Tools that chloe can add to an agent, each switched on or off with `true`
 * or `false`, for example `abilities: { scripts: true }`. A few take their
 * fields instead of `true`, like `googleMail: { search: "in:inbox", days: 3 }`;
 * the file says only what differs from the default. The page's Abilities view
 * switches them and fills the fields in, by changing this object in
 * `agent.ts`. `allAbilities()` is the list, with what each one is when unsaid.
 * A plugin adds its own to this interface from its folder.
 */
export interface Abilities {
  /**
   * Adds the tool `scriptRun`, which lets the agent run any file in its own
   * `scripts/` folder. Off by default.
   *
   * Each script runs as a program, so it must be executable (`chmod +x`, with
   * a `#!` first line). It runs inside the `scripts/` folder, and gets the
   * agent's memory folder in the `MEMORY_FOLDER` environment variable. If this
   * is on and `scripts/` is empty, the agent does not load.
   *
   * Write a skill that tells the agent when to use each script.
   */
  scripts?: boolean;
  /**
   * Adds the tools `folderListFiles`, `folderReadFile` and
   * `folderSearchFiles`, which read the folders named in `paths`, like a
   * project's code, and never write to them. Off by default, and adds nothing
   * until `paths` names a folder.
   *
   * The model names a folder by the last part of its path, so no two may end
   * the same. In a git repository, what git ignores is left out (`.env.local`,
   * `dist/`), and so is any `.env`, `.git`, `secrets` and `node_modules`
   * anywhere. A guest on a web channel gets them only if the channel names
   * them, like any other tool.
   */
  folders?: boolean | FoldersAbility;
}

/** The fields of `abilities.folders`. */
export interface FoldersAbility {
  /** Full paths of the folders it may read, like `"/home/you/shop"`. Default: none, so it reads nothing. */
  paths?: string[];
  /** A few words for those folders, like `"the shop's code"`, said to the model. Default: their names. */
  about?: string;
}

/** One ability: what it is when unsaid, what it does in a line, the tools it adds and the fields it takes. */
export interface Ability {
  name: keyof Abilities;
  /** What the dashboard calls it. */
  label: string;
  on: boolean;
  does: string;
  /** Every tool it can add. Which it does add can depend on its fields. */
  tools: string[];
  /** The fields it takes besides being on, when it takes any. */
  fields?: OptionSpec[];
  /** Fields that bring every tool, so the page can show what they would add. */
  preview?: Record<string, unknown>;
  /** The connection its tools work through. */
  needs?: Connection;
  /** The tools it adds for one agent, from its fields with every default filled in. */
  make(home: Home, values: Record<string, unknown>): Tools;
  /** Throws, saying why, when it is on for an agent it cannot work for. `where` names the agent. */
  check?(home: Home, values: Record<string, unknown>, where: string): void;
}


/** Every ability, each plugin's in the list's order and then the core's, which is the order the page shows them. A test holds `tools` to what each one adds. */
export const allAbilities = (): Ability[] => [...PLUGINS.flatMap((one) => one.abilities ?? []), ...CORE];

/** The abilities the core brings, after the plugins'. */
const CORE: Ability[] = [
  {
    name: "scripts",
    label: "Scripts",
    on: false,
    does: "Runs the scripts in its scripts/ folder and in its skills' folders.",
    tools: ["scriptRun"],
    make: (home) => scriptTools()(home),
    check(home, _values, where) {
      if (scriptsIn(home.folder).length === 0) {
        throw new Error(`${where} has abilities.scripts on, and no scripts: neither ${home.folder}/scripts nor an executable file in a skill folder.`);
      }
    },
  },
  {
    name: "folders",
    label: "Folders",
    on: false,
    does: "Reads the folders you name, like a project's code, and never writes to them. What git ignores is left out.",
    tools: ["folderListFiles", "folderReadFile", "folderSearchFiles"],
    fields: [
      { name: "paths", label: "Folders", about: "Full paths of the folders it may read, like /home/you/shop. The model knows each by its last part.", kind: "list", default: [] },
      about("those folders"),
    ],
    preview: { paths: [tmpdir()] },
    make: (_home, v) => folderTools({ paths: v.paths as string[], about: (v.about as string) || undefined }),
    check(_home, values, where) {
      const paths = values.paths as string[];
      for (const path of paths) {
        if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
          throw new Error(`${where}: abilities.folders names ${path}, which is not a folder. Give each one's full path.`);
        }
      }
      const twice = paths.map((path) => basename(path)).find((name, i, all) => all.indexOf(name) !== i);
      if (twice) throw new Error(`${where}: abilities.folders names two folders called ${twice}. The model knows each by its last part, so each must end differently.`);
    },
  },
];

/** The ability of this name. */
export const abilityNamed = (name: keyof Abilities): Ability | undefined => allAbilities().find((one) => one.name === name);

/** Whether this ability is on for an agent with these `abilities`: true, or its fields written out, unless it says false. */
export function abilityOn(abilities: Abilities | undefined, name: keyof Abilities): boolean {
  const said = abilities?.[name];
  return said === undefined ? (abilityNamed(name)?.on ?? false) : said !== false;
}

/** The fields `abilities.<name>` says, with every default filled in. Refused when one is not what its field takes. */
export function abilityValues(abilities: Abilities | undefined, name: keyof Abilities, where = "abilities"): Record<string, unknown> {
  const ability = abilityNamed(name);
  if (!ability) throw new Error(`There is no ability called ${name}.`);
  const said = abilities?.[name];
  return readOptions(ability.fields ?? [], typeof said === "object" ? said : undefined, `${where}.${name}`, true);
}

/**
 * The tools an ability adds for this agent, from the fields `abilities` says.
 * With `preview`, from the fields that bring every tool, so the page can show
 * what switching it on, or filling its fields in, would add.
 */
export function abilityToolSet(home: Home, name: keyof Abilities, abilities?: Abilities, preview = false): Tools {
  const ability = abilityNamed(name);
  if (!ability) throw new Error(`There is no ability called ${name}.`);
  const values = abilityValues(preview ? undefined : abilities, name);
  return ability.make(home, preview ? { ...values, ...ability.preview } : values);
}

/**
 * What an agent's `abilities` turn on, as tools, under where each comes from,
 * like `abilities.memory`. A value that is not what its ability takes is
 * refused, and so is `scripts` with nothing to run.
 */
export function abilityTools(abilities: Abilities = {}, home: Home, where: string): Record<string, Tools> {
  for (const [name, value] of Object.entries(abilities)) {
    const ability = allAbilities().find((one) => one.name === name);
    if (!ability) throw new Error(`${where}: abilities has no ${name}. There are ${allAbilities().map((one) => one.name).join(", ")}.`);
    if (value === undefined || typeof value === "boolean") continue;
    if (!ability.fields) throw new Error(`${where}: abilities.${name} is true or false.`);
    abilityValues(abilities, ability.name, `${where}: abilities`);
  }
  for (const one of allAbilities()) if (one.check && abilityOn(abilities, one.name)) one.check(home, abilityValues(abilities, one.name), where);
  return Object.fromEntries(
    allAbilities().filter((one) => abilityOn(abilities, one.name)).map((one) => [`abilities.${one.name}`, abilityToolSet(home, one.name, abilities)]),
  );
}

export { defaultOf };
