import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * One thing a menu can do. A line on its own is a divider, and a head is a
 * line of text that says what the menu is about and cannot be pressed.
 */
export type Choice =
  | {
      label: string;
      run: () => void;
      danger?: boolean;
      disabled?: boolean;
      current?: boolean;
      title?: string;
    }
  | { head: string }
  | "line";

type Pressable = Extract<Choice, { label: string }>;

/**
 * A menu at the pointer, for a right-click. It closes on the next click
 * anywhere, on Escape, on a scroll of the page, and when the window loses focus, because a
 * menu left open over a page that moved underneath it points at the wrong
 * thing.
 *
 * It is kept inside the window: opened near the right or bottom edge it is
 * shifted back in rather than cut off.
 *
 * Given `search`, it opens with a box at the top that keeps only the choices
 * whose label has every word typed, and Enter runs the first one left. The box
 * has the focus as it opens, except on a touch screen.
 */
export function ContextMenu({
  at,
  choices,
  close,
  from = "left",
  search,
}: {
  at: { x: number; y: number };
  choices: Choice[];
  close: () => void;
  /** Which edge of the menu x is: the left by default, the right under a button in the bar. */
  from?: "left" | "right";
  /** The words in an empty search box. Without it there is no box. */
  search?: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const [typed, setTyped] = useState("");
  const shown = search ? matching(choices, typed) : choices;

  // Before it is painted, so a menu that has to be moved back inside the
  // window, or hung from its right edge, is never seen in the wrong place.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const left = from === "right" ? at.x - width : at.x;
    menu.style.left = `${Math.max(6, Math.min(left, window.innerWidth - width - 6))}px`;
    menu.style.top = `${Math.min(at.y, window.innerHeight - height - 6)}px`;
    // Measured once, so the menu does not shrink and jump about as the search narrows it.
    if (search) menu.style.minWidth = `${width}px`;
    // On a touch screen the search box waits to be tapped: focused at once, it
    // would bring the keyboard up over the list on every open.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    menu.querySelector<HTMLElement>(search && !touch ? "input" : "button:not(:disabled)")?.focus({ preventScroll: true });
  }, [at, from, search]);

  useEffect(() => {
    const menu = ref.current;
    const away = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      // A long menu scrolls inside itself, and that moves nothing underneath it.
      if ((event.type === "mousedown" || event.type === "scroll") && menu?.contains(event.target as Node)) return;
      close();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", away);
    window.addEventListener("scroll", away, true);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", away);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("blur", away);
    };
  }, [at, close]);

  return (
    <ul ref={ref} className="context-menu" role="menu" style={{ left: at.x, top: at.y }}>
      {search && (
        <li className="search" role="none">
          <input
            type="search"
            placeholder={search}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
              }
              if (event.key !== "Enter") return;
              const first = shown.find((one): one is Pressable => typeof one === "object" && "label" in one && !one.disabled);
              if (first) {
                close();
                first.run();
              }
            }}
          />
        </li>
      )}
      {shown.map((choice, index) =>
        choice === "line" ? (
          <li key={`line-${index}`} className="line" role="separator" />
        ) : "head" in choice ? (
          <li key={`head-${index}`} className="head" role="presentation" title={choice.head}>
            <span className="who">{choice.head}</span>
          </li>
        ) : (
          <li key={`${index}-${choice.label}`} role="none">
            <button
              role="menuitem"
              className={choice.danger ? "danger" : undefined}
              disabled={choice.disabled}
              aria-current={choice.current ? "true" : undefined}
              title={choice.title}
              onClick={() => {
                close();
                choice.run();
              }}
            >
              {choice.label}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * The choices whose label has every word typed. A head is kept only with a
 * choice under it, and a line only between two groups that are both kept.
 */
function matching(choices: Choice[], typed: string): Choice[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return choices;
  const out: Choice[] = [];
  let line = false;
  let head: Choice | undefined;
  for (const choice of choices) {
    if (choice === "line") [line, head] = [true, undefined];
    else if ("head" in choice) head = choice;
    else if (words.every((word) => choice.label.toLowerCase().includes(word))) {
      if (line && out.length) out.push("line");
      if (head) out.push(head);
      out.push(choice);
      [line, head] = [false, undefined];
    }
  }
  return out;
}
