// The guides in docs/, with the code in them filled in from the repo.
//
//   node ops/docs.ts            checks every page
//   node ops/docs.ts dist/docs  checks them, then writes them there for the package
//
// No code block in docs/ is written in the docs. Each one names a file, and this
// reads it: `file=example/jobs/stuck-orders.ts` is the whole file and
// `file=index.ts#defineJob` is one export out of the runtime. So a page cannot
// show code that does not compile, because it is the code.
//
// The package ships the pages written out by this, so whoever installed chloe
// reads the guides for the version they have. chloejs.org renders the same
// pages with the same functions, so the two cannot disagree. Run by `npm run
// check` and by the build, never by the service, and not compiled into dist/:
// it needs typescript, which only the repo has.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * This repo. A quote's path is relative to it. From import.meta.url rather than
 * import.meta.dirname, because chloejs.org bundles this file and its bundler
 * keeps the one and drops the other.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The written pages. */
export const DOCS = join(ROOT, "docs");
/** Where a link that is not to another page goes. */
const SITE = "https://chloejs.org";

export interface Page {
  /** The file name without `.md`, which is also its address on the site. */
  slug: string;
  title: string;
  order: number;
  summary: string;
  /** The slug of the page this one sits under in a list of pages, from `under` in its frontmatter. */
  under?: string;
  /** The markdown, with every `file=` block filled in. */
  body: string;
}

/** A `file=<path>` or `file=<path>#<export>` in a fence's info line. */
export interface Quote {
  spec: string;
  path: string;
  name?: string;
}

const FENCE = /^```([a-z]*)\s+file=(\S+)\s*$/gm;

export function quotesIn(markdown: string): Quote[] {
  return [...markdown.matchAll(FENCE)].map(([, , spec]) => {
    const [path, name] = spec.split("#");
    return { spec, path, name };
  });
}

/**
 * What a quote points at: a whole file, one export by name, or `#default` for
 * the default export. Throws with the spec in the message when the file or the
 * export is not there, which is what makes a stale page a failed check rather
 * than a wrong one.
 */
export function quoted({ spec, path, name }: Quote): string {
  let text: string;
  try {
    text = readFileSync(join(ROOT, path), "utf8");
  } catch {
    throw new Error(`file=${spec}: there is no ${path}.`);
  }
  if (!name) return text.trimEnd();

  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    // "#default" is the export a job, an agent or a channel file is: the one
    // thing in it worth quoting on its own.
    if (name === "default" ? !ts.isExportAssignment(statement) : named(statement) !== name) continue;
    // getFullText carries the doc comment above it, which is the half worth
    // quoting.
    return statement.getFullText(source).trim();
  }
  throw new Error(`file=${spec}: ${path} has nothing called ${name}.`);
}

/** The name a top-level statement declares, for matching a quote against. */
function named(statement: ts.Statement): string | undefined {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name?.text;
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return statement.name.text;
  if (ts.isVariableStatement(statement)) {
    const [first] = statement.declarationList.declarations;
    return ts.isIdentifier(first.name) ? first.name.text : undefined;
  }
  return undefined;
}

/**
 * The lines of a file from the one holding `from` to the one holding `to`, with
 * the common indent taken off. Either end matching no line, or more than one,
 * throws: a slice that quietly lands somewhere else would put the wrong code on
 * the page and still build.
 */
export function slice(code: string, from: string, to: string): string {
  const lines = code.split("\n");
  const at = (what: string): number => {
    const hits = lines.map((one, i) => ({ one, i })).filter(({ one }) => one.includes(what));
    if (hits.length === 0) throw new Error(`No line holds ${JSON.stringify(what)}, so the slice has no ${what === from ? "start" : "end"}.`);
    if (hits.length > 1) throw new Error(`${hits.length} lines hold ${JSON.stringify(what)}. Slice on something that appears once.`);
    return hits[0].i;
  };
  const start = at(from);
  const end = at(to);
  if (end < start) throw new Error(`The slice ends before it starts: ${JSON.stringify(from)} is below ${JSON.stringify(to)}.`);
  const kept = lines.slice(start, end + 1);
  const indent = Math.min(...kept.filter((one) => one.trim()).map((one) => one.length - one.trimStart().length));
  return kept.map((one) => one.slice(indent)).join("\n");
}

/** The markdown with every quote filled in, ready to render. */
export function filled(markdown: string): string {
  return markdown.replace(FENCE, (line) => {
    const [quote] = quotesIn(line);
    return `${line.replace(/\s+file=\S+/, "")}\n${quoted(quote)}`;
  });
}

const FRONT = /^---\n([\s\S]*?)\n---\n/;

/** Every page in docs/, in the order they are read. */
export function pages(): Page[] {
  const found = readdirSync(DOCS)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const raw = readFileSync(join(DOCS, file), "utf8");
      const front = FRONT.exec(raw);
      if (!front) throw new Error(`docs/${file} has no frontmatter, so it has no title.`);
      const said = new Map(
        front[1].split("\n").map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
        }),
      );
      return {
        slug: file.replace(/\.md$/, ""),
        title: said.get("title") ?? file,
        order: Number(said.get("order") ?? 99),
        summary: said.get("summary") ?? "",
        under: said.get("under") || undefined,
        body: filled(raw.slice(front[0].length)),
      };
    });
  return found.sort((a, b) => a.order - b.order);
}

/**
 * The pages that may write a TypeScript block of their own rather than quote
 * one: a cron line, an import list, a settings shape, a tool binding. Every
 * other block names a file.
 */
const MAY_WRITE = new Set(["jobs", "models", "settings", "entrances", "connections"]);

/** What is wrong with the pages, one line each. Empty when nothing is. */
export function problems(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(DOCS).filter((one) => one.endsWith(".md"))) {
    const markdown = readFileSync(join(DOCS, file), "utf8");
    if (!FRONT.test(markdown)) found.push(`docs/${file} has no frontmatter.`);
    for (const quote of quotesIn(markdown)) {
      try {
        quoted(quote);
      } catch (error) {
        found.push(`docs/${file}: ${(error as Error).message}`);
      }
    }
    const slug = file.replace(/\.md$/, "");
    if (!MAY_WRITE.has(slug) && /^```ts\s*$/m.test(markdown)) {
      found.push(`docs/${file} writes its own TypeScript. Quote a file with file=<path> instead.`);
    }
  }
  if (found.length) return found;
  const all = pages();
  return [
    ...all.filter((one) => !one.title || !one.summary).map((one) => `docs/${one.slug}.md has no title or no summary in its frontmatter.`),
    ...all
      .filter((one) => one.under && !all.some((other) => other.slug === one.under && !other.under))
      .map((one) => `docs/${one.slug}.md is under ${one.under}, which is not a page of its own.`),
  ];
}

/**
 * A page as it is read from the package: a link to another page becomes the
 * file beside it, and any other link on the site becomes a whole address.
 */
function forPackage(markdown: string): string {
  return markdown.replace(/\]\(\/docs\/([a-z0-9-]+)(#[^)]*)?\)/g, "](./$1.md$2)").replace(/\]\(\//g, `](${SITE}/`);
}

/** The first page an agent or a person opens in the package: every page, and where the rest is. */
function index(all: Page[]): string {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  return `# Chloe ${version}

These guides are for the version of @chloejs/core installed beside them, so
read them rather than the website when the two differ: ${SITE} shows the
latest release.

Read them in this order the first time. Each line is a page and what it covers.

${all.map((one) => `- [${one.title}](./${one.slug}.md): ${one.summary}`).join("\n")}

Every exported name, with what it does, is in the \`.d.ts\` files one folder
up: \`index.d.ts\` for \`@chloejs/core\`, \`channels/index.d.ts\`,
\`services/index.d.ts\`, \`timer/index.d.ts\`, and \`core/settings.d.ts\`
for every setting and its default. A channel's setup (which tokens, which
scopes, where each comes from) is the comment at the top of
\`channels/<name>.js\`.

\`npx chloe help\` lists every command.
`;
}

/** Writes every page and the index into `to`, replacing whatever was there. */
export function writeDocs(to: string): number {
  const all = pages();
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const one of all) {
    writeFileSync(join(to, `${one.slug}.md`), `# ${one.title}\n\n> ${one.summary}\n\n${forPackage(one.body.trim())}\n`);
  }
  writeFileSync(join(to, "README.md"), index(all));
  return all.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wrong = problems();
  if (wrong.length) {
    console.error(`The guides in docs/ need fixing:\n${wrong.map((one) => `  ${one}`).join("\n")}`);
    process.exit(1);
  }
  const to = process.argv[2];
  if (to) console.log(`wrote ${writeDocs(resolve(to))} guides and their index into ${to}`);
  else console.log(`The ${pages().length} guides in docs/ quote nothing that has moved.`);
}
