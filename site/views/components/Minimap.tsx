import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * The whole of what is in `pane`, drawn small down its right edge, with a box
 * for the part on screen. Click or drag to scroll there.
 *
 * It is a scaled copy of the pane's own elements rather than a render of text,
 * so it always matches what is shown. Only for what this page draws itself
 * (markdown and code): a note in a frame belongs to another origin and cannot
 * be read from here, which is the point of the frame.
 *
 * `scale` is the one number: every measurement is the pane's own pixels times it.
 */
export function Minimap({ pane, revision }: { pane: RefObject<HTMLDivElement | null>; revision: unknown }) {
  const map = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);

  const place = useCallback(
    (at: number) => {
      const scroller = pane.current;
      if (!scroller || !at || scroller.scrollHeight - scroller.clientHeight <= 1) return setBox(null);
      setBox({ top: scroller.scrollTop * at, height: Math.max(8, scroller.clientHeight * at) });
    },
    [pane],
  );

  const draw = useCallback(() => {
    const scroller = pane.current;
    const into = inner.current;
    if (!scroller || !into || !map.current) return;
    const copy = scroller.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[id]").forEach((one) => one.removeAttribute("id"));
    copy.style.overflow = "visible";
    copy.style.height = "auto";
    into.replaceChildren(copy);
    // Laid out at the pane's own width, or it wraps differently from the page.
    const width = Math.max(scroller.clientWidth, 1);
    into.style.width = `${width}px`;
    const next = Math.min(map.current.clientWidth / width, map.current.clientHeight / Math.max(scroller.scrollHeight, 1));
    into.style.transform = `scale(${next})`;
    setScale(next);
    place(next);
  }, [pane, place]);

  useEffect(() => {
    const timer = setTimeout(draw, 50);
    const scroller = pane.current;
    const resized = window.ResizeObserver ? new ResizeObserver(() => draw()) : null;
    if (scroller && resized) resized.observe(scroller);
    return () => {
      clearTimeout(timer);
      resized?.disconnect();
    };
  }, [draw, pane, revision]);

  useEffect(() => {
    const scroller = pane.current;
    const moved = () => place(scale);
    scroller?.addEventListener("scroll", moved, { passive: true });
    return () => scroller?.removeEventListener("scroll", moved);
  }, [pane, place, scale]);

  /** The point clicked becomes the middle of the pane. */
  function jump(y: number) {
    const scroller = pane.current;
    if (!scroller || !map.current || !scale) return;
    const to = (y - map.current.getBoundingClientRect().top) / scale - scroller.clientHeight / 2;
    scroller.scrollTop = Math.min(Math.max(scroller.scrollHeight - scroller.clientHeight, 0), Math.max(0, to));
  }

  return (
    <div
      className="minimap"
      ref={map}
      aria-hidden="true"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        jump(event.clientY);
      }}
      onPointerMove={(event) => event.buttons === 1 && jump(event.clientY)}
    >
      <div className="minimap-inner" ref={inner} />
      {box && <div className="minimap-box" style={{ top: box.top, height: box.height }} />}
    </div>
  );
}
