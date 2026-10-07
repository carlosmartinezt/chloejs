// A markdown file cut into the blocks the page shows one at a time, and where
// in one of them a reader had got to.

export interface Block {
  from: number;
  to: number;
  source: string;
}

/**
 * The file cut into blocks: a run of lines with a blank one on either side,
 * except that a fence and the frontmatter at the top are each one block
 * whatever is inside them. `from` and `to` are where it sits in the file, so a
 * block written back leaves everything around it exactly as it was.
 */
export function parts(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let at = 0;
  let n = 0;

  while (n < lines.length) {
    if (!lines[n].trim()) {
      at += lines[n].length + 1;
      n++;
      continue;
    }
    const from = at;
    const fence = /^\s*(```|~~~)/.exec(lines[n])?.[1];
    const top = from === 0 && lines[n].trim() === "---";
    at += lines[n].length + 1;
    n++;
    if (fence || top) {
      const end = fence ?? "---";
      while (n < lines.length) {
        const line = lines[n];
        at += line.length + 1;
        n++;
        if (line.trimStart().startsWith(end)) break;
      }
    } else {
      while (n < lines.length && lines[n].trim()) {
        at += lines[n].length + 1;
        n++;
      }
    }
    const to = Math.min(at - 1, text.length);
    out.push({ from, to, source: text.slice(from, to) });
  }

  return out;
}

/**
 * Where the words somebody has read reach in the source behind them. What is
 * on screen is the source with its marks taken out, so the two are walked
 * together and anything the reader never saw is stepped over.
 */
export function sourceAt(source: string, seen: string): number {
  let i = 0;
  for (let j = 0; j < seen.length && i < source.length; j++) {
    while (i < source.length && source[i] !== seen[j]) i++;
    i++;
  }
  return Math.min(i, source.length);
}
