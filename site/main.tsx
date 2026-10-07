// The runtime's own page: the agents, what each is set up to do, its recent
// runs, its memory, the tokens and the API docs. An installed page package
// replaces it everywhere but /api (see serve/page.ts).
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { api, SIGNED_OUT } from "./api.ts";
import { go, Link, usePath } from "./route.tsx";
import { AgentPage, Home } from "./views/Agents.tsx";
import { Docs } from "./views/Docs.tsx";
import { Login } from "./views/Login.tsx";
import { Memory } from "./views/Memory.tsx";
import { Tokens } from "./views/Tokens.tsx";

function App() {
  const path = usePath();
  const [signedIn, setSignedIn] = useState<boolean>();

  useEffect(() => {
    api.check().then(() => setSignedIn(true), () => setSignedIn(false));
    const out = () => setSignedIn(false);
    window.addEventListener(SIGNED_OUT, out);
    return () => window.removeEventListener(SIGNED_OUT, out);
  }, []);

  // The docs are open, so they are shown whether or not anybody is signed in.
  if (path === "/api") return <Frame signedIn={Boolean(signedIn)} wide><Docs /></Frame>;
  if (signedIn === undefined) return null;
  if (!signedIn) {
    return (
      <Login
        onIn={() => {
          setSignedIn(true);
          if (path === "/login") go("/");
        }}
      />
    );
  }

  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  let view: ReactNode;
  if (path === "/" || path === "/login") view = <Home />;
  else if (path === "/tokens") view = <Tokens />;
  else if (parts[0] === "agents" && parts[1] && parts.length === 2) view = <AgentPage id={parts[1]} />;
  else if (parts[0] === "agents" && parts[1] && parts[2] === "memory") {
    view = <Memory agent={parts[1]} path={parts.slice(3).join("/")} />;
  } else {
    view = (
      <>
        <h1>Not here</h1>
        <p className="dim">
          No page at <code>{path}</code>.
        </p>
      </>
    );
  }
  return <Frame signedIn wide={parts[2] === "memory"}>{view}</Frame>;
}

function Frame({ signedIn, wide, children }: { signedIn: boolean; wide?: boolean; children: ReactNode }) {
  const path = usePath();
  const here = (to: string) => (to === "/" ? path === "/" || path.startsWith("/agents") : path === to) ? "here" : undefined;
  return (
    <>
      <header className="bar">
        <Link to="/" className="mark">
          <span className="dot" aria-hidden />
          chloe
        </Link>
        <nav>
          <Link to="/" className={here("/")}>Agents</Link>
          <Link to="/tokens" className={here("/tokens")}>Tokens</Link>
          <Link to="/api" className={here("/api")}>API</Link>
        </nav>
        {signedIn ? (
          <button className="quiet" onClick={() => void api.signOut().finally(() => (location.href = "/"))}>
            Sign out
          </button>
        ) : (
          <a href="/" className="quiet">Sign in</a>
        )}
      </header>
      <main className={wide ? "wide" : undefined}>{children}</main>
    </>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
