import { type CSSProperties, useEffect, useState } from "react";

import { cloud } from "../lib/api.ts";
import { labelOf } from "../lib/format.ts";
import { chatsIn, homeOf } from "../lib/home.ts";
import * as prefs from "../lib/prefs.ts";
import type { Me, Workspace } from "../lib/types.ts";

/**
 * Account settings. How the page looks is this browser's alone: it is kept in
 * local storage and never sent anywhere, so the same account on another
 * computer keeps its own. On a cloud, the chat the front page opens is the
 * account's, and follows it everywhere.
 */
export function Settings({
  email,
  signOut,
  me,
  said,
}: {
  email?: string;
  signOut?: () => void;
  /** On a cloud, the account, for the front page. */
  me?: Me | null;
  said?: (me: Me) => void;
}) {
  return (
    <>
      <div className="head">
        <h1>Account settings</h1>
      </div>

      {me && said && <FrontPage me={me} said={said} />}

      <section className="setting">
        <h2>Appearance</h2>
        <p className="empty">
          Chloe has a light side and a dark one and follows this computer unless you say otherwise.
          The rest are the colours of a code editor, each drawn here in its own and each already one
          or the other. Every choice here is kept in this browser, so another computer signed in as
          you keeps the one it was given.
        </p>
        <Looks />
      </section>

      <section className="setting">
        <h2>Account</h2>
        {email ? (
          <>
            <p className="empty">
              Signed in as <span className="mono">{email}</span>.
            </p>
            {signOut && (
              <button className="small" onClick={signOut}>
                Sign out
              </button>
            )}
          </>
        ) : (
          <p className="empty">
            This runtime has one password and no accounts, so there is nothing here to tell apart.
          </p>
        )}
      </section>
    </>
  );
}

/** Which agent the front page opens a chat with: one of every agent this account can chat with. */
function FrontPage({ me, said }: { me: Me; said: (me: Me) => void }) {
  const [all, setAll] = useState<Workspace[] | null>(null);
  const [trouble, setTrouble] = useState("");
  useEffect(() => {
    cloud.workspaces().then(setAll, () => setAll([]));
  }, []);
  if (!all?.some((one) => chatsIn(one).length)) return null;
  const now = homeOf(me, all);
  const choose = async (value: string) => {
    const [workspace, agent] = value.split("/");
    try {
      said(await cloud.setHome(value ? { workspace, agent } : null));
      setTrouble("");
    } catch (error) {
      setTrouble((error as Error).message);
    }
  };
  return (
    <section className="setting">
      <h2>Front page</h2>
      <p className="empty">The agent you are chatting with when you open Chloe.</p>
      <select
        aria-label="Front page"
        value={me.home && now ? `${now.workspace}/${now.agent}` : ""}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="">The first one there is{now && !me.home ? `, ${labelOf(now.agent)}` : ""}</option>
        {all.map((one) => (
          <optgroup key={one.name} label={one.label}>
            {chatsIn(one).map((agent) => (
              <option key={agent} value={`${one.name}/${agent}`}>
                {labelOf(agent)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {trouble && <p className="bad">{trouble}</p>}
    </section>
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
