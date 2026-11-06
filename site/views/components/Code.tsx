import { useState } from "react";

import { languageOf, tokens } from "../../lib/code.ts";
import { copy } from "../../lib/copy.ts";
import * as Icons from "./Icons.tsx";

/**
 * A file, or a fenced block, painted, with a button to take a copy of it.
 * `language` is a file name or whatever the fence said it was, and anything not
 * recognised is shown as it is.
 */
export function Code({ text, language }: { text: string; language?: string }) {
  const pieces = tokens(text, languageOf(language ?? ""));
  return (
    <div className="code">
      <pre className="painted">
        {pieces.map((piece, at) =>
          piece.kind === "plain" ? (
            piece.text
          ) : (
            <span key={at} className={piece.kind}>
              {piece.text}
            </span>
          ),
        )}
      </pre>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * A button that puts `text` on the clipboard, and shows a tick when it did.
 * With a `label` it is one of what can be done with a message, and says so in the same tip as the others.
 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  // null until the button has been pressed, then whether the browser allowed it.
  const [copied, setCopied] = useState<boolean | null>(null);

  async function take() {
    const done = await copy(text);
    setCopied(done);
    if (done) setTimeout(() => setCopied(null), 1500);
  }

  const tip = copied === false ? "This browser would not let the page copy" : copied ? "Copied" : (label ?? "Copy");

  return (
    <button
      className={label ? "plain act" : "plain copy"}
      aria-label={copied ? "Copied" : (label ?? "Copy this")}
      title={label ? undefined : tip}
      data-tip={label ? tip : undefined}
      onClick={() => void take()}
    >
      {copied ? <Icons.Tick /> : <Icons.Copy />}
    </button>
  );
}
