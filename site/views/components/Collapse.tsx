import { useEffect, useState, type ReactNode } from "react";

import * as Icons from "./Icons.tsx";

/**
 * What a phone turns a sidebar into: a word and a menu that opens over the
 * page under it, instead of a column that is always on top of the thing it
 * leads to. On a wide screen the toggle is hidden and the children are the
 * column they always were, because the wrapper is display: contents and shows
 * no box of its own.
 */
export function Collapse({ closeOn, label = "Menu", children }: { closeOn?: string; label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // The menu closes itself once it has done its job: a press on a place goes
  // somewhere, and it should not stay open over the new page.
  useEffect(() => setOpen(false), [closeOn]);
  return (
    <div className={open ? "menu-root open" : "menu-root"}>
      <button className="menu-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icons.Menu />
        {label}
        <Icons.Down />
      </button>
      <div className="menu-body">{children}</div>
    </div>
  );
}