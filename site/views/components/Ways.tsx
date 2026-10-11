import type { ReactNode } from "react";

import type { Way } from "../../lib/types.ts";

/**
 * A list of ways in or ways out, which are the same shape: what it is called,
 * what it is for, whether whatever it needs has been filled in, and how it was
 * set up. One that is not set up and says what is missing shows those lines in
 * place of the settings it waits on. The setting holding a credential is named so somebody knows where to
 * go, and its value is never here.
 */
export function Ways({ ways, empty, more }: { ways: Way[] | null; empty: string; more?: (way: Way) => ReactNode }) {
  if (ways === null) return <p className="dim">Loading</p>;
  if (ways.length === 0) return <p className="empty frame">{empty}</p>;
  return (
    <ul className="ways">
      {ways.map((way) => (
        <li key={way.name}>
          <span className="line">
            <b>{way.name}</b>
            {/* Words, not a button: a dot and what it is. Nothing at all when there is nothing to set up. */}
            {way.ready === null ? null : way.ready ? <span className="state free">Ready</span> : <span className="state bad">Not ready</span>}
          </span>
          <span className="does">{way.does}</span>
          {way.ready === false && way.missing?.length ? (
            way.missing.map((line) => (
              <span key={line} className="dim needs">
                {line}
              </span>
            ))
          ) : way.needs && !way.ready ? (
            <span className="num dim needs">Needs {way.needs} in chloe.config.ts</span>
          ) : null}
          {way.settings?.length ? (
            <ul className="set">
              {way.settings.map((one) => (
                <li key={one.name}>
                  <i>{one.name}:</i> {one.value}
                </li>
              ))}
            </ul>
          ) : null}
          {more?.(way)}
        </li>
      ))}
    </ul>
  );
}
