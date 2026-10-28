import { useEffect, useId, useState, type ReactNode } from "react";

import * as Icons from "./Icons.tsx";
import { announceMenu, watchMenu } from "../../lib/menus.ts";

/**
 * What a phone turns a sidebar into: a word and a menu that opens over the
 * page under it, instead of a column that is always on top of the thing it
 * leads to. On a wide screen the toggle is hidden and the children are the
 * column they always were, because the wrapper is display: contents and shows
 * no box of its own.
 */
export function Collapse({
  closeOn,
  label = "Menu",
  icon = <Icons.Menu />,
  children,
}: {
  closeOn?: string;
  label?: string;
  /** Beside the label, and all a page shows when it hides the label to keep the toggle to one round button. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // The menu closes itself once it has done its job: a press on a place goes
  // somewhere, and it should not stay open over the new page.
  useEffect(() => setOpen(false), [closeOn]);
  // Opening the bar's menu, or another sidebar's, closes this one.
  useEffect(() => watchMenu((which) => which !== id && setOpen(false)), [id]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    announceMenu(next ? id : null);
  };
  return (
    <div className={open ? "menu-root open" : "menu-root"}>
      <button className="menu-toggle" aria-label={label} aria-expanded={open} onClick={toggle}>
        {icon}
        <span className="label">{label}</span>
        <Icons.Down />
      </button>
      <div className="menu-body">{children}</div>
    </div>
  );
}