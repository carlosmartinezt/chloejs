import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";

import { parts, sourceAt, type Block } from "../../lib/blocks.ts";
import { Markdown } from "./Markdown.tsx";

/**
 * A markdown file, read as it will look and written in place: every block is
 * the formatted words until it is clicked, and the one clicked is its own
 * source until the caret leaves it.
 *
 * The file itself is the state, and a block is a stretch of it. While one is
 * open the text on either side is held apart from it, so typing a blank line
 * cannot move the block out from under the caret.
 */
export function Live({
  text,
  onChange,
  onSave,
}: {
  text: string;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState<{ before: string; source: string; after: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);

  // A block grows and shrinks as it is typed in, so the box is as tall as what
  // is in it and the page never scrolls inside a paragraph.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [open?.source]);

  // Where the click landed, once the box it landed in is on screen.
  useEffect(() => {
    const el = box.current;
    if (!el || caret.current === null) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [open]);

  function start(block: Block, at: number) {
    caret.current = at;
    setOpen({ before: text.slice(0, block.from), source: block.source, after: text.slice(block.to) });
  }

  function typed(source: string) {
    if (!open) return;
    setOpen({ ...open, source });
    onChange(open.before + source + open.after);
  }

  /** Below the last block is the end of the file, which is where writing goes on. */
  function tail(event: MouseEvent) {
    if (event.target !== event.currentTarget) return;
    const blocks = parts(text);
    const last = blocks[blocks.length - 1];
    if (last) start(last, last.source.length);
    else start({ from: text.length, to: text.length, source: "" }, 0);
  }

  // What is after the open block is cut on its own, so where those blocks sit
  // in the file is their own place plus everything in front of them.
  const past = open ? open.before.length + open.source.length : 0;
  const before = open ? parts(open.before) : [];
  const after = open
    ? parts(open.after).map((block) => ({ ...block, from: block.from + past, to: block.to + past }))
    : [];

  return (
    <div className="live" onClick={tail}>
      {(open ? before : parts(text)).map((block) => (
        <Shown key={block.from} block={block} onOpen={start} />
      ))}
      {open && (
        <textarea
          ref={box}
          className="source"
          value={open.source}
          spellCheck
          rows={1}
          onChange={(event) => typed(event.target.value)}
          onBlur={() => setOpen(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.blur();
              return;
            }
            if (!(event.metaKey || event.ctrlKey)) return;
            if (event.key === "s") {
              event.preventDefault();
              onSave();
            } else if (event.key === "b" || event.key === "i") {
              event.preventDefault();
              const marked = wrap(event.currentTarget, event.key === "b" ? "**" : "*");
              caret.current = null;
              typed(marked.text);
              queueMicrotask(() => box.current?.setSelectionRange(marked.at[0], marked.at[1]));
            }
          }}
        />
      )}
      {after.map((block) => (
        <Shown key={block.from} block={block} onOpen={start} />
      ))}
    </div>
  );
}

/** One block as it reads. A click in it says where in its source the caret goes. */
function Shown({ block, onOpen }: { block: Block; onOpen: (block: Block, at: number) => void }) {
  const el = useRef<HTMLDivElement>(null);

  // Closing the open block changes the height of the page, which would move
  // this one out from under the click, so the box keeps the focus until the
  // click has been read.
  function hold(event: MouseEvent) {
    if ((document.activeElement as HTMLElement | null)?.classList.contains("source")) event.preventDefault();
  }

  function click(event: MouseEvent) {
    // A link is followed, and a click that ends a selection leaves it alone.
    if ((event.target as HTMLElement).closest("a")) return;
    if (!window.getSelection()?.isCollapsed) return;
    event.stopPropagation();
    onOpen(block, el.current ? at(el.current, block.source, event.clientX, event.clientY) : block.source.length);
  }

  return (
    <div className="block" ref={el} onMouseDown={hold} onClick={click}>
      {front(block.source) ? <pre className="front">{block.source}</pre> : <Markdown text={block.source} />}
    </div>
  );
}

const front = (source: string) => /^---\n[\s\S]*\n---$/.test(source);

/**
 * Where a click on the formatted words lands in the source behind them.
 */
function at(el: HTMLElement, source: string, x: number, y: number): number {
  const point = caretIn(x, y);
  if (!point || !el.contains(point.node)) return source.length;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(point.node, point.offset);
  return sourceAt(source, range.toString());
}

/** The two names browsers give the same thing. */
function caretIn(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const spot = doc.caretPositionFromPoint?.(x, y);
  if (spot) return { node: spot.offsetNode, offset: spot.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * Puts marks round what is selected, or takes them off again when they are
 * already there, whether they are inside the selection or just outside it.
 * Returns the new text and where the same words now start and end.
 */
function wrap(box: HTMLTextAreaElement, mark: string): { text: string; at: [number, number] } {
  const { value, selectionStart: from, selectionEnd: to } = box;
  const picked = value.slice(from, to);
  const width = mark.length;

  if (value.slice(from - width, from) === mark && value.slice(to, to + width) === mark) {
    return {
      text: value.slice(0, from - width) + picked + value.slice(to + width),
      at: [from - width, to - width],
    };
  }
  if (picked.startsWith(mark) && picked.endsWith(mark) && picked.length > width * 2) {
    return {
      text: value.slice(0, from) + picked.slice(width, -width) + value.slice(to),
      at: [from, to - width * 2],
    };
  }
  return {
    text: `${value.slice(0, from)}${mark}${picked}${mark}${value.slice(to)}`,
    at: [from + width, to + width],
  };
}
