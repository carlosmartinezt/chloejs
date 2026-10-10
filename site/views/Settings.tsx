import { type CSSProperties, useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import * as prefs from "../lib/prefs.ts";

/**
 * Account settings. How the page looks is this browser's alone: it is kept in
 * local storage and never sent anywhere, so the same account on another
 * computer keeps its own.
 */
export function Settings() {
  return (
    <>
      <div className="head">
        <h1>Account settings</h1>
      </div>

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
        <Password />
      </section>

      <section className="setting" id="keys">
        <h2>Keys</h2>
        <Keys />
      </section>
    </>
  );
}

/**
 * The runtime's one password. A copy with none opens only with a link it
 * printed, and the first password is set here, by the browser already in.
 * Changing one takes a shell on the box.
 */
function Password() {
  const [exists, setExists] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    api.account().then(
      (said) => setExists(said.exists),
      () => setExists(null),
    );
  }, []);

  async function set(event: React.FormEvent) {
    event.preventDefault();
    setTrouble("");
    try {
      await api.setup(password);
      setExists(true);
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  if (exists === null) return null;
  if (exists) {
    return (
      <p className="empty">
        This runtime signs in with one password, or with a link from <code>npx chloe link</code> in its folder. A new
        password is <code>npx chloe account</code> there, which signs every browser out.
      </p>
    );
  }
  return (
    <>
      <p className="empty">
        No password: this runtime opens with a link from <code>npx chloe link</code> in its folder, which signs one
        browser in for a week. Set a password to sign in without one, from any browser that reaches this page.
      </p>
      <form className="row" onSubmit={set}>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
          aria-label="Password"
        />
        <button className="small" type="submit" disabled={password.length < 8}>
          Set password
        </button>
      </form>
      {trouble && <p className="bad">{trouble}</p>}
    </>
  );
}

/**
 * What .env sets, by name, and a box to paste NAME=value lines into it. A
 * value is sent once and never shown again. `?key=NAME` in the address starts
 * the box with that name, which is how an agent sends its owner here.
 */
function Keys() {
  const [names, setNames] = useState<string[] | null>(null);
  const [lines, setLines] = useState(() => {
    const name = new URLSearchParams(window.location.search).get("key");
    // One well-formed name and nothing else, so a link cannot slip a line of its own in.
    return name && /^CHLOE_[A-Z0-9_]+$/.test(name) ? `${name}=` : "";
  });
  const [trouble, setTrouble] = useState("");
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState(false);

  // Somebody invited is refused .env, and is not shown the box at all.
  useEffect(() => {
    api.keys().then(setNames, () => setRefused(true));
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setTrouble("");
    setSaved(false);
    try {
      setNames(await api.setKeys(lines));
      setLines("");
      setSaved(true);
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Take ${name} out of .env?`)) return;
    try {
      setNames(await api.removeKey(name));
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }

  if (refused) return null;
  return (
    <>
      <p className="empty">
        Every password, key and token chloe uses is a line in <code>.env</code>, beside <code>chloe.config.ts</code>.
        Paste one or more lines here, as <code>CHLOE_SOMETHING=value</code>, and each replaces the line that name had.
        What you paste goes straight into the file and is never shown again, here or to an agent. The config still
        has to hand each one over, as <code>process.env.CHLOE_SOMETHING</code>.
      </p>
      <form onSubmit={save}>
        <textarea
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={lines}
          onChange={(event) => setLines(event.target.value)}
          placeholder="CHLOE_CONNECTIONS_BRAVE_API_KEY=..."
          aria-label="Lines for .env"
        />
        <button className="small" type="submit" disabled={!lines.includes("=")}>
          Save to .env
        </button>
      </form>
      {saved && <p className="empty">Saved. The settings were read again.</p>}
      {trouble && <p className="bad">{trouble}</p>}
      {names && names.length === 0 && <p className="empty">.env sets nothing yet.</p>}
      {names && names.length > 0 && (
        <table className="tight">
          <tbody>
            {names.map((name) => (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td className="right">
                  {name.startsWith("CHLOE_") && (
                    <button className="small" onClick={() => void remove(name)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
