import { useState } from "react";

import { api, useLoad, type RouteDoc } from "../api.ts";

const WHO: { who: RouteDoc["who"]; title: string }[] = [
  { who: "anybody", title: "Anybody" },
  { who: "account or token", title: "The account or a token" },
  { who: "account", title: "The account only" },
];

/** Every route the runtime answers, read from GET /api, the same list the server routes by. */
export function Docs() {
  const { data, trouble } = useLoad(api.routes, []);
  const [find, setFind] = useState("");
  const words = find.trim().toLowerCase();
  const shown = (data ?? []).filter(
    (one) => !words || `${one.method} ${one.path} ${one.does}`.toLowerCase().includes(words),
  );

  return (
    <>
      <div className="head">
        <h1>The API</h1>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="Find a route"
          aria-label="Find a route"
        />
      </div>
      <p className="dim">
        Every route this runtime answers. It listens on loopback and is not meant to be put on a public name.
      </p>

      <dl className="facts">
        <dt>anybody</dt>
        <dd>The ways in. Each says as little as it can.</dd>
        <dt>account</dt>
        <dd>
          Signed in on this box, as the cookie or as <code>Authorization: Bearer &lt;what /api/login returned&gt;</code>.
          Can do everything.
        </dd>
        <dt>token</dt>
        <dd>
          Another system, as <code>Authorization: Bearer chloe_...</code>. Reading, plus chat and jobs for the agents
          that bind an api channel, or for its one agent. Never writing, and never the tokens. Made at{" "}
          <a href="/tokens">Tokens</a>.
        </dd>
      </dl>

      <pre>{`curl ${location.origin}/api/agents -H "authorization: Bearer $CHLOE_TOKEN"`}</pre>
      <p className="dim small">
        This list as JSON is <code>curl {location.origin}/api</code>.
      </p>

      {trouble && <p className="bad">{trouble}</p>}
      {WHO.map(({ who, title }) => {
        const found = shown.filter((one) => one.who === who);
        if (!found.length) return null;
        return (
          <section key={who}>
            <h2>{title}</h2>
            <div className="routes">
              {found.map((one) => (
                <div key={`${one.method} ${one.path}`} className="route">
                  <div>
                    <span className={`method ${one.method.toLowerCase()}`}>{one.method}</span>
                    <code>{one.path}</code>
                    {one.needsApiChannel && <span className="tag">api channel</span>}
                  </div>
                  <p>{one.does}</p>
                  {one.takes && <code className="takes">{one.takes}</code>}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {data && !shown.length && <p className="dim">No route matches.</p>}
    </>
  );
}
