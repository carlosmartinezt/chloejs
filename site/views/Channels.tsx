import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { labelOf } from "../lib/format.ts";
import type { Way } from "../lib/types.ts";
import { Ways } from "./components/Ways.tsx";

/** The ways in: everywhere somebody or something can reach this agent. */
export function Channels({ agent }: { agent: string }) {
  const [ways, setWays] = useState<Way[] | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    let stale = false;
    setWays(null);
    setTrouble("");
    api.channels(agent).then(
      (all) => !stale && setWays(all),
      (error: Error) => !stale && setTrouble(missing(error, "channels")),
    );
    return () => void (stale = true);
  }, [agent]);

  return (
    <>
      <div className="head">
        <h1>Channels</h1>
      </div>
      <p className="empty">The ways in: how a person or another system reaches {labelOf(agent)}.</p>
      {trouble ? (
        <p className="empty frame bad">{trouble}</p>
      ) : (
        <Ways ways={ways} empty={`${labelOf(agent)} binds none. It runs on its jobs and on this page.`} />
      )}
    </>
  );
}
