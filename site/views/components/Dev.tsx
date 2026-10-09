import { useEffect, useState } from "react";

import { api } from "../../lib/api.ts";

/**
 * A strip across the top of a server that says it is a copy somebody is working
 * on, with the folder it is running out of, so a dev copy and the real one are
 * never mistaken for each other.
 *
 * It asks the server itself rather than being handed the answer, so it is one
 * line in main.tsx and shows on every page, the way in included. A server that
 * does not say it is a dev copy gets nothing.
 */
export function Dev() {
  const [root, setRoot] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    void api.account().then(
      (said) => !stale && said.dev && setRoot(said.root ?? ""),
      () => {},
    );
    return () => void (stale = true);
  }, []);

  if (root === null) return null;
  return (
    <div className="dev">
      <b>Dev only</b>
      {root && <span className="num">{root}</span>}
    </div>
  );
}
