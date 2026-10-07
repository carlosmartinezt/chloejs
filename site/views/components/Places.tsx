import { labelOf } from "../../lib/format.ts";
import type { View } from "../../lib/route.ts";
import * as Icons from "./Icons.tsx";
import { Link } from "./Link.tsx";

/**
 * The top of the sidebar, the same on every page inside one agent: whose
 * pages these are, and every one of them. The name is the way to the whole of
 * it, which is where its files are. Each page puts its own thing under
 * this, so moving between them never moves the column out from under the
 * pointer.
 *
 * The order is what somebody does with an agent, most often first: read what
 * it is told, read what it knows, then how it is reached and what it reaches.
 */
export function Places({ agent, view }: { agent: string; view: View }) {
  const on = (at: View["at"]) => view.at === at;
  return (
    <div className="places">
      {/* The name is the way back to the whole of it, and a heading for the
          rest. The bar switches agents; this only says whose these are. */}
      <Link to={{ at: "agent", agent }} className="whose" current={on("agent") || on("file")}>
        {labelOf(agent)}
      </Link>
      <Link to={{ at: "instructions", agent }} current={on("instructions")}>
        <Icons.Inspect />
        Instructions
      </Link>
      <Link to={{ at: "skills", agent }} current={on("skills")}>
        <Icons.Card />
        Skills
      </Link>
      <Link to={{ at: "jobs", agent }} current={on("jobs")}>
        <Icons.Clock />
        Jobs
      </Link>
      <Link to={{ at: "tools", agent }} current={on("tools")}>
        <Icons.Tool />
        Tools
      </Link>
      <Link to={{ at: "channels", agent }} current={on("channels")}>
        <Icons.In />
        Channels
      </Link>
      <Link to={{ at: "connections", agent }} current={on("connections")}>
        <Icons.Out />
        Connections
      </Link>
    </div>
  );
}
