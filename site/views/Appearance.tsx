import { type CSSProperties, useState } from "react";

import * as prefs from "../lib/prefs.ts";

/**
 * How the page looks. It is this browser's alone: kept in local storage and
 * never sent anywhere, so the same account on another computer keeps its own.
 */
export function Appearance() {
  return (
    <>
      <div className="head">
        <h1>Appearance</h1>
      </div>

      <section className="setting">
        <p className="empty">
          Chloe has a light side and a dark one and follows this computer unless you say otherwise.
          The rest are the colours of a code editor, each drawn here in its own and each already one
          or the other. Every choice here is kept in this browser, so another computer signed in as
          you keeps the one it was given.
        </p>
        <Looks />
      </section>
    </>
  );
}

/**
 * Every look, each square painted by the theme it offers, and under them the
 * two things Chloe's own look can be told. They are shown only when it is the
 * one on, because a code editor's colours carry their own light or dark and
 * their own bar, and neither of these would move them.
 */
function Looks() {
  const [theme, setTheme] = useState(prefs.theme);
  const [mode, setMode] = useState(prefs.mode);
  const [bar, setBar] = useState(prefs.bar);
  return (
    <>
      <div className="looks">
      {prefs.THEMES.map(([name, title]) => {
        const on = theme === name;
        return (
          <button
            key={name || "chloe"}
            className={`look ${on ? "on" : ""}`}
            aria-pressed={on}
            onClick={() => {
              prefs.setTheme(name);
              setTheme(name);
            }}
          >
            {/* A small page: the bar, two lines of writing and one thing to
                press. data-theme paints it, the same attribute the page wears. */}
            <span className="swatch" data-theme={name || "chloe"} aria-hidden="true">
              <span className="top" />
              <span className="rule" />
              <span className="rule short" />
              <span className="spot" />
            </span>
            <span className="name">{title}</span>
          </button>
        );
      })}
      </div>

      {theme === "" && (
        <>
          <h3 className="sub">Light or dark</h3>
          <div className="modes">
            {prefs.MODES.map(([value, title]) => (
              <button
                key={value || "system"}
                className="mode"
                aria-pressed={mode === value}
                onClick={() => {
                  prefs.setMode(value);
                  setMode(value);
                }}
              >
                {title}
              </button>
            ))}
          </div>

          <h3 className="sub">The band across the top</h3>
          <div className="bands">
            {prefs.BARS.map(([hue, title]) => (
              <button
                key={hue}
                className="band"
                style={{ "--bar-hue": hue } as CSSProperties}
                aria-pressed={bar === hue}
                onClick={() => {
                  prefs.setBar(hue);
                  setBar(hue);
                }}
              >
                <span className="strip" aria-hidden="true" />
                {title}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
