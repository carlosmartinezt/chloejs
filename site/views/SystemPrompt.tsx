import { useEffect, useState } from "react";

import { api, missing } from "../lib/api.ts";
import { Link } from "./components/Link.tsx";
import { Markdown } from "./components/Markdown.tsx";

/**
 * Everything a reply of an agent starts with, as one written by its owner on
 * the dashboard has it: its name, its purpose, who it is talking to, what the
 * runtime and its plugins add, its skills and the date. The purpose is a link
 * to its own page in its place, where it is read and edited, so this shows
 * what is added around it.
 */
export function SystemPrompt({ agent }: { agent: string }) {
  const [said, setSaid] = useState<{ text: string; purpose: string } | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    let stale = false;
    setSaid(null);
    setTrouble("");
    api.prompt(agent).then(
      (found) => !stale && setSaid(found),
      (error: Error) => !stale && setTrouble(missing(error, "prompt")),
    );
    return () => void (stale = true);
  }, [agent]);

  return (
    <>
      <div className="head">
        <h1>System Prompt</h1>
      </div>
      {trouble && <p className="empty frame bad">{trouble}</p>}
      {said === null && !trouble && <p className="dim">Loading</p>}
      {said !== null && (
        <>
          <p className="dim">What a reply to you on the dashboard starts with. Another channel, person or set of tools changes only those parts.</p>
          <section className="told">
            <div className="prose">
              {said.text.split(said.purpose).map((part, n) => (
                <div key={n}>
                  {n > 0 && (
                    <p>
                      <Link to={{ at: "purpose", agent }}>{said.purpose}</Link>
                    </p>
                  )}
                  <Markdown text={part} />
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
