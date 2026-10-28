import type { ReactNode } from "react";

import { Code, CopyButton } from "./Code.tsx";
import * as Icons from "./Icons.tsx";
import { colourOf, markFor } from "../../lib/sites.ts";

/**
 * The marks inside a line: **bold**, `code`, *italic* and [words](address).
 * Built as elements rather than as HTML, because some of what is rendered here
 * is words from a model, and words from a model are never handed to the browser
 * as markup.
 */
const MARKS = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![*\w])\*([^*\n]+)\*(?!\w)/g;

export function rich(words: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let key = 0;
  MARKS.lastIndex = 0;
  for (let found = MARKS.exec(words); found; found = MARKS.exec(words)) {
    if (found.index > at) out.push(words.slice(at, found.index));
    if (found[1]) out.push(<strong key={key++}>{found[1]}</strong>);
    else if (found[2]) out.push(<code key={key++}>{found[2]}</code>);
    else if (found[3]) out.push(link(found[3], found[4], key++));
    else out.push(<em key={key++}>{found[5]}</em>);
    at = found.index + found[0].length;
  }
  if (at < words.length) out.push(words.slice(at));
  return out;
}

/** The words as a reader sees them: headings, quotes and the marks inside a line taken off. */
export function unmarked(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>\s?/, ""))
    .join("\n")
    .replace(MARKS, (_, bold, code, text, _to, em) => bold ?? code ?? text ?? em);
}

/** Only an address a browser can follow safely. Anything else stays as text. */
function link(text: string, to: string, key: number): ReactNode {
  const safe = /^(https?:\/\/|\/|#|mailto:)/i.test(to);
  const away = safe && elsewhere(to);
  if (away) return <Away key={key} text={text} href={to} url={away} />;
  return safe ? (
    <a key={key} href={to} target={to.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
      {text}
    </a>
  ) : (
    <span key={key}>{text}</span>
  );
}

/** The address when it is on another site than this page, or null. */
function elsewhere(to: string): URL | null {
  if (!/^https?:\/\//i.test(to)) return null;
  try {
    const url = new URL(to);
    return typeof location !== "undefined" && url.origin === location.origin ? null : url;
  } catch {
    return null;
  }
}

/** A link to another site, as a button: the site's mark, the words, and a sign that it opens a new window. */
function Away({ text, href, url }: { text: string; href: string; url: URL }) {
  const mark = markFor(url);
  return (
    <a className="away" href={href} target="_blank" rel="noreferrer" title={href}>
      {mark ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill={colourOf(mark) ?? "currentColor"} role="img" aria-label={mark.title}>
          <path d={mark.path} />
        </svg>
      ) : (
        <Icons.Globe />
      )}
      <span>{text}</span>
      <Icons.NewWindow />
    </a>
  );
}

/**
 * A whole markdown file, read rather than edited: headings, lists, quotes,
 * fenced code, rules and paragraphs. Anything it does not know stays a
 * paragraph, so nothing is ever dropped.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="read">{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let at = 0;
  let key = 0;

  while (at < lines.length) {
    const line = lines[at];

    if (!line.trim()) {
      at++;
      continue;
    }

    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const end = fence[1];
      const code: string[] = [];
      at++;
      while (at < lines.length && !lines[at].trimStart().startsWith(end)) code.push(lines[at++]);
      at++;
      // A fence marked `writing` is words to be used somewhere else, a song or
      // a message to send: read as prose, and copied without its marks.
      if (fence[2].trim().toLowerCase() === "writing") {
        out.push(
          <div key={key++} className="writing">
            <div className="label">Writing</div>
            <CopyButton text={unmarked(code.join("\n"))} />
            <div className="read">{blocks(code.join("\n"))}</div>
          </div>,
        );
      } else out.push(<Code key={key++} text={code.join("\n")} language={fence[2]} />);
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      at++;
      continue;
    }

    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const Tag = `h${Math.min(head[1].length + 1, 6)}` as "h2";
      out.push(<Tag key={key++}>{rich(head[2])}</Tag>);
      at++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (at < lines.length && /^\s*>/.test(lines[at])) quoted.push(lines[at++].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key++}>{blocks(quoted.join("\n"))}</blockquote>);
      continue;
    }

    // A table is a row of cells between pipes with a rule of dashes under it.
    // Without the rule it is only a line with pipes in it, and stays one.
    if (row(line) && at + 1 < lines.length && rule(lines[at + 1])) {
      const head = cells(line);
      const align = cells(lines[at + 1]).map((one) =>
        one.endsWith(":") ? (one.startsWith(":") ? "center" : "right") : one.startsWith(":") ? "left" : undefined,
      );
      at += 2;
      const body: string[][] = [];
      while (at < lines.length && row(lines[at])) body.push(cells(lines[at++]));
      out.push(
        <div key={key++} className="table-wrap">
          <table>
            <thead>
              <tr>
                {head.map((cell, n) => (
                  <th key={n} style={{ textAlign: align[n] }}>
                    {rich(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((cellsOf, r) => (
                <tr key={r}>
                  {head.map((_, n) => (
                    <td key={n} style={{ textAlign: align[n] }}>
                      {rich(cellsOf[n] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const numbered = /^\s*\d/.test(line);
      const alike = (one: string) => bullet.test(one) && /^\s*\d/.test(one) === numbered;
      const items: string[] = [];
      while (at < lines.length && alike(lines[at])) {
        items.push(lines[at++].replace(bullet, ""));
        // A line under an item, indented, belongs to it.
        while (at < lines.length && /^\s+\S/.test(lines[at]) && !bullet.test(lines[at])) {
          items[items.length - 1] += ` ${lines[at++].trim()}`;
        }
        // Blank lines between items of the same kind are one list spaced out,
        // not a list per item, which would number each of them 1.
        let next = at;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next > at && next < lines.length && alike(lines[next])) at = next;
      }
      const made = items.map((item, n) => <li key={n}>{rich(item)}</li>);
      // A list numbered from somewhere else, because words came between it and the one before, says so.
      const start = numbered ? Number(/\d+/.exec(line)![0]) : 1;
      out.push(numbered ? <ol key={key++} start={start === 1 ? undefined : start}>{made}</ol> : <ul key={key++}>{made}</ul>);
      continue;
    }

    const words: string[] = [];
    // Always at least one line: a heading with spaces in front of it is not a
    // heading to this renderer, and it must still be a paragraph and not a
    // loop that never moves.
    do {
      words.push(lines[at++]);
    } while (
      at < lines.length &&
      lines[at].trim() &&
      !/^\s*(#{1,6}\s|>|```|~~~)/.test(lines[at]) &&
      !bullet.test(lines[at]) &&
      !(row(lines[at]) && at + 1 < lines.length && rule(lines[at + 1]))
    );
    out.push(<p key={key++}>{rich(words.join("\n"))}</p>);
  }

  return out;
}

/** A line that is a table row: it starts with a pipe, or has one between cells. */
function row(line: string): boolean {
  return /^\s*\|/.test(line) || /\S\s*\|\s*\S/.test(line);
}

/** The line under a table's head: dashes, with a colon at an end to align. */
function rule(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

/** One row's cells, trimmed. A pipe inside `code` or written \| stays in the cell. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let code = false;
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let n = 0; n < body.length; n++) {
    const c = body[n];
    if (c === "\\" && body[n + 1] === "|") {
      cell += "|";
      n++;
    } else if (c === "`") {
      code = !code;
      cell += c;
    } else if (c === "|" && !code) {
      out.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}
