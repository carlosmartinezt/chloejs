import { useState } from "react";

import { together } from "../../lib/format.ts";

/** One answer to pick: the words on it, and what picking it sends. */
export interface Option {
  label: string;
  sends: string;
}

/**
 * The answers to a question: a button for each, which sends it, or with
 * `multiple` a button to press for each and "Send", which sends the pressed
 * ones together.
 */
export function Pick({ options, multiple, disabled, pick }: { options: Option[]; multiple?: boolean; disabled?: boolean; pick: (text: string) => void }) {
  const [on, setOn] = useState<string[]>([]);
  if (!multiple) {
    return (
      <div className="pick">
        {options.map((one) => (
          <button key={one.sends} className="pill" disabled={disabled} onClick={() => pick(one.sends)}>
            {one.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="pick">
      {options.map((one) => {
        const pressed = on.includes(one.sends);
        return (
          <button
            key={one.sends}
            className="pill"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => setOn((now) => (pressed ? now.filter((sends) => sends !== one.sends) : [...now, one.sends]))}
          >
            {one.label}
          </button>
        );
      })}
      <button
        className="go small"
        disabled={disabled || !on.length}
        onClick={() => pick(together(options.filter((one) => on.includes(one.sends)).map((one) => one.sends)))}
      >
        Send
      </button>
    </div>
  );
}
