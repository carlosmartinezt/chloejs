import { Fragment, useEffect, useState } from "react";

import type { SharedChat } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { nameOf, saidAt, when } from "../lib/format.ts";
import { CopyButton } from "./components/Code.tsx";
import { Link } from "./components/Link.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { withoutFiles, written } from "./Chat.tsx";

/**
 * A conversation somebody shared, to read and not to write: what was said and
 * who shared it, with no list beside it and no box to type in. Anybody signed
 * in may open it, whatever they were given.
 */
export function Shared({ thread }: { thread: string }) {
  const [chat, setChat] = useState<SharedChat | null>(null);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    setChat(null);
    setTrouble("");
    api.shared(thread).then(setChat, (error) => setTrouble((error as Error).message));
  }, [thread]);

  return (
    <div className="chat shared">
      <div className="talking">
        <div className="head">
          <Link to={{ at: "home" }} className="mark" aria-label="Chloe">
            <span className="glyph" />
          </Link>
          <span className="model">{chat ? chat.label || `A chat with ${nameOf(chat.agent)}` : "A shared chat"}</span>
        </div>
        <div className="scroll">
          <div className="thread run-thread">
            {trouble && <p className="said-at">{trouble}</p>}
            {chat && <p className="said-at">{chat.by ? `Shared by ${chat.by}, to read only` : "Shared to read only"}</p>}
            {chat?.said.map((line, at) =>
              line.role === "user" ? (
                <Fragment key={at}>
                  {line.at && <p className="said-at num">{saidAt(line.at)}</p>}
                  <div className="msg you">
                    <div className="bubble">{written(line.content)}</div>
                  </div>
                </Fragment>
              ) : line.summary ? (
                <details className="msg summed" key={at}>
                  <summary>Compacted: what came before, summed up{line.at && <span className="num">, {when(line.at)}</span>}</summary>
                  <div className="said">
                    <Markdown text={line.content} />
                  </div>
                </details>
              ) : (
                <Fragment key={at}>
                  {line.at && chat.said[at - 1]?.role !== "user" && <p className="said-at num">{saidAt(line.at)}</p>}
                  <div className="msg them">
                    <div className="said">
                      <Markdown text={line.content} />
                    </div>
                    <div className="meta num">
                      <CopyButton text={withoutFiles(line.content)} label="Copy response" />
                      {[nameOf(chat.agent), line.at && when(line.at)].filter(Boolean).join(", ")}
                    </div>
                  </div>
                </Fragment>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
