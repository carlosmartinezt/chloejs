import { useEffect, useLayoutEffect, useRef } from "react";

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

/**
 * A menu at the pointer, for a right-click. It closes on the next click
 * anywhere, on Escape, on scroll, and when the window loses focus, because a
 * menu left open over a page that moved underneath it points at the wrong
 * thing.
 *
 * It is kept inside the window: opened near the right or bottom edge it is
 * shifted back in rather than cut off.
 */
export function ContextMenu({
  at,
  choices,
  close,
  from = "left",
}: {
  at: { x: number; y: number };
  choices: Choice[];
  close: () => void;
  /** Which edge of the menu x is: the left by default, the right under a button in the bar. */
  from?: "left" | "right";
}) {
  const ref = useRef<HTMLUListElement>(null);

  // Before it is painted, so a menu that has to be moved back inside the
  // window, or hung from its right edge, is never seen in the wrong place.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const left = from === "right" ? at.x - width : at.x;
    menu.style.left = `${Math.max(6, Math.min(left, window.innerWidth - width - 6))}px`;
    menu.style.top = `${Math.min(at.y, window.innerHeight - height - 6)}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [at, from]);

  useEffect(() => {
    const menu = ref.current;
    const away = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "mousedown" && menu?.contains(event.target as Node)) return;
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
      {choices.map((choice, index) =>
        choice === "line" ? (
          <li key={`line-${index}`} className="line" role="separator" />
        ) : "head" in choice ? (
          <li key={`head-${index}`} className="head" role="presentation" title={choice.head}>
            <span className="who">{choice.head}</span>
          </li>
        ) : (
          <li key={choice.label} role="none">
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
