import { useState } from "react";

import { cloud } from "../../lib/api.ts";
import { go, workspace as inside } from "../../lib/route.ts";
import type { Workspace } from "../../lib/types.ts";
import { ContextMenu, type Choice } from "./ContextMenu.tsx";

/**
 * What an owner can do to one workspace, as menu choices. The list of
 * workspaces and a workspace's own page both offer these, so the two cannot
 * drift apart. People and Keys are pages of the workspace's own. `tried` runs a
 * change and says what went wrong; `gone` is called once it is deleted.
 */
export function workspaceChoices(
  one: Workspace,
  { tried, gone }: { tried: (what: () => Promise<unknown>) => unknown; gone: () => void },
): Choice[] {
  // Already inside it, a step in the history; from the list, a fresh load,
  // because another workspace is another runtime and nothing held is true of it.
  const open = (page: "people" | "keys") =>
    inside() === one.name ? go({ at: page }) : window.location.assign(`/workspaces/${encodeURIComponent(one.name)}/${page}`);
  return [
    { label: "People", run: () => open("people") },
    { label: "Keys", run: () => open("keys") },
    {
      label: "Rename",
      run: () => {
        const called = window.prompt("What to call it", one.label);
        if (called && called.trim()) void tried(() => cloud.rename(one.name, called));
      },
    },
    {
      label: "Delete",
      run: () => {
        if (window.confirm(`Delete ${one.label}? Its keys are revoked and its runtime disconnected. What it sent is kept.`)) {
          void tried(async () => {
            await cloud.remove(one.name);
            gone();
          });
        }
      },
    },
  ];
}

/** The "…" button that opens a workspace's menu. */
export function Dots({ label, choices }: { label: string; choices: () => Choice[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className="small"
        aria-label={`What to do with ${label}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: box.left, y: box.bottom + 6 });
        }}
      >
        &hellip;
      </button>
      {menu && <ContextMenu at={menu} close={() => setMenu(null)} choices={choices()} />}
    </>
  );
}
