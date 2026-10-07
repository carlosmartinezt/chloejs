import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { labelOf } from "../lib/format.ts";
import type { Way } from "../lib/types.ts";
import { SignIn } from "./components/SignIn.tsx";
import { Ways } from "./components/Ways.tsx";

/** The ways out: what this agent reaches that is not on this box, and what each is missing. */
export function Connections({ agent }: { agent: string }) {
  const [ways, setWays] = useState<Way[] | null>(null);
  const [trouble, setTrouble] = useState("");

  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let stale = false;
    setTrouble("");
    api.connections(agent).then(
      (all) => !stale && setWays(all),
      (error: Error) => !stale && setTrouble(missing(error, "connections")),
    );
    return () => void (stale = true);
  }, [agent, asked]);

  useEffect(() => setWays(null), [agent]);

  return (
    <>
      <div className="head">
        <h1>Connections</h1>
      </div>
      <p className="empty">The ways out: what {labelOf(agent)} reaches that is not on this box.</p>
      {trouble ? (
        <p className="empty frame bad">{trouble}</p>
      ) : (
        <Ways
          ways={ways}
          empty={`No connections at the moment. What ${labelOf(agent)} can do is under Tools.`}
          more={(way) => (way.signIn ? <SignIn agent={agent} name={way.name} again={way.ready === true} done={() => setAsked((n) => n + 1)} /> : null)}
        />
      )}
    </>
  );
}
