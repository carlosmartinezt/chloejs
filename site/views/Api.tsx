import { useEffect, useState } from "react";

import { api, type RouteDoc } from "../lib/api.ts";

const WHO: { who: RouteDoc["who"]; title: string }[] = [
  { who: "anybody", title: "Anybody" },
  { who: "account or token", title: "The account or a token" },
  { who: "account", title: "The account only" },
];

/** Every route the runtime answers, read from GET /api, the same list the server routes by. Shown without signing in. */
export function Api() {
  const [routes, setRoutes] = useState<RouteDoc[] | null>(null);
  const [trouble, setTrouble] = useState("");
  const [find, setFind] = useState("");

  useEffect(() => {
    api.routes().then(setRoutes, (error: Error) => setTrouble(error.message));
  }, []);

  const words = find.trim().toLowerCase();
  const shown = (routes ?? []).filter(
    (one) => !words || `${one.method} ${one.path} ${one.does}`.toLowerCase().includes(words),
  );

  return (
    <>
      <header className="bar">
        <a href="/" className="mark">
          <span className="glyph" />
          Chloe
        </a>
      </header>
      <main className="pane front api-list">
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
        <p className="dim">
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
                      {one.needsApiChannel && <span className="route-tag">api channel</span>}
                    </div>
                    <p>{one.does}</p>
                    {one.takes && <code className="takes">{one.takes}</code>}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        {routes && !shown.length && <p className="dim">No route matches.</p>}
      </main>
    </>
  );
}
