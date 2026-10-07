import { useEffect, useState, type ReactNode } from "react";

import { copy } from "../../lib/copy.ts";

/**
 * A path that copies itself when pressed, and says so for a moment in a tip
 * where it was pressed. The tip is fixed to the window rather than to the
 * button, because a path is often in something that cuts off what overflows
 * it, and the tip would be cut off with it.
 */
export function CopyPath({ path, className, children }: { path: string; className?: string; children?: ReactNode }) {
  const [tip, setTip] = useState<{ x: number; y: number; said: string } | null>(null);

  useEffect(() => {
    if (!tip) return;
    const timer = setTimeout(() => setTip(null), 1500);
    return () => clearTimeout(timer);
  }, [tip]);

  async function take(event: React.MouseEvent<HTMLButtonElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    // From a key there is no pointer, so the tip goes over the middle instead.
    const x = event.clientX || box.left + box.width / 2;
    const done = await copy(path);
    setTip({
      x: Math.min(Math.max(x, 80), window.innerWidth - 80),
      y: box.top,
      said: done ? "Path copied" : "This browser would not copy",
    });
  }

  return (
    <button className={className ? `copy-path ${className}` : "copy-path"} title={`Copy ${path}`} onClick={take}>
      {children ?? path}
      {tip && (
        <span className="tip" role="status" style={{ left: tip.x, top: tip.y }}>
          {tip.said}
        </span>
      )}
    </button>
  );
}
