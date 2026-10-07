import type { ReactNode } from "react";

import { Code } from "./Code.tsx";

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

/** Only an address a browser can follow safely. Anything else stays as text. */
function link(text: string, to: string, key: number): ReactNode {
  const safe = /^(https?:\/\/|\/|#|mailto:)/i.test(to);
  return safe ? (
    <a key={key} href={to} target={to.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
      {text}
    </a>
  ) : (
    <span key={key}>{text}</span>
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
      out.push(<Code key={key++} text={code.join("\n")} language={fence[2]} />);
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
      const items: string[] = [];
      while (at < lines.length && bullet.test(lines[at])) {
        items.push(lines[at++].replace(bullet, ""));
        // A line under an item, indented, belongs to it.
        while (at < lines.length && /^\s+\S/.test(lines[at]) && !bullet.test(lines[at])) {
          items[items.length - 1] += ` ${lines[at++].trim()}`;
        }
      }
      const made = items.map((item, n) => <li key={n}>{rich(item)}</li>);
      out.push(numbered ? <ol key={key++}>{made}</ol> : <ul key={key++}>{made}</ul>);
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
