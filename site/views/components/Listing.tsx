import * as Icons from "./Icons.tsx";
import { when } from "../../lib/format.ts";
import type { Sort, SortBy } from "../../lib/prefs.ts";
import type { Entry } from "../../lib/types.ts";

/** A folder as a table: name, size and when it changed, sorted by any of them. Folders stay first. */
export function Listing({
  entries,
  sort,
  resort,
  pick,
  menu,
}: {
  entries: Entry[];
  sort: Sort;
  resort: (next: Sort) => void;
  pick: (entry: Entry) => void;
  menu: (event: React.MouseEvent, entry: Entry) => void;
}) {
  const order = [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const by =
      sort.by === "size"
        ? (a.size ?? 0) - (b.size ?? 0)
        : sort.by === "modified"
          ? (a.modified ?? "").localeCompare(b.modified ?? "")
          : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return sort.down ? -by : by;
  });

  const head = (by: SortBy, label: string) => (
    <th aria-sort={sort.by === by ? (sort.down ? "descending" : "ascending") : undefined}>
      <button onClick={() => resort({ by, down: sort.by === by ? !sort.down : by !== "name" })}>
        {label}
        {sort.by === by && <span className="dim">{sort.down ? " ↓" : " ↑"}</span>}
      </button>
    </th>
  );

  if (!entries.length) return <p className="empty pad">Nothing in here.</p>;
  return (
    <div className="listing">
      <table>
        <thead>
          <tr>
            {head("name", "Name")}
            {head("size", "Size")}
            {head("modified", "Modified")}
          </tr>
        </thead>
        <tbody>
          {order.map((entry) => (
            <tr key={entry.path} onContextMenu={(event) => menu(event, entry)}>
              <td>
                <button className="listing-name" onClick={() => pick(entry)} title={entry.path}>
                  <span className="row-icon">{entry.dir ? <Icons.Folder /> : <Icons.File />}</span>
                  {entry.name}
                </button>
              </td>
              <td className="num dim">{entry.dir ? `${entry.children?.length ?? 0} in it` : bytes(entry.size)}</td>
              <td className="num dim">{entry.modified ? when(entry.modified) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function bytes(n = 0): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
