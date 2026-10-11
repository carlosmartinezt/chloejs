import { useCallback, useEffect, useState } from "react";

import { api, type Key } from "../lib/api.ts";
import type { Field } from "../lib/types.ts";
import { CodeEditor } from "./components/CodeEditor.tsx";
import { type Ask, Fields } from "./components/Fields.tsx";
import { GoogleSetup } from "./components/GoogleSetup.tsx";

/**
 * The whole copy's settings, as forms: what chloe.config.ts and .env say,
 * changed where they say it. A form changes a plain value in the file, and a
 * key goes into .env with the file naming it. Anything the forms do not cover,
 * or the file says as code, is the file itself, at the bottom.
 */
export function Configuration() {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [trouble, setTrouble] = useState("");
  // The file as text is read again after a form saves, so the two never disagree.
  const [round, setRound] = useState(0);

  const refresh = useCallback(() => {
    api.fields().then(setFields, (error: Error) => setTrouble(error.message));
  }, []);
  useEffect(refresh, [refresh]);

  const saved = (all: Field[]) => {
    setFields(all);
    setRound((n) => n + 1);
  };

  return (
    <>
      <div className="head">
        <h1>Configuration</h1>
      </div>
      <p className="empty">
        Settings for every agent. They are saved in <code>chloe.config.ts</code>, and keys in <code>.env</code>. If a
        save breaks something, the old file stays.
      </p>
      {trouble && <p className="empty frame bad">{trouble}</p>}

      {fields && (
        <>
          <section className="setting" id="google">
            <h2>Google</h2>
            <p className="empty">Get Gmail, Google Calendar and Google Drive.</p>
            <GoogleSetup
              done={() => {
                refresh();
                setRound((n) => n + 1);
              }}
            />
          </section>

          <section className="setting" id="models">
            <h2>Models</h2>
            <Fields fields={fields} saved={saved} asks={MODELS} />
          </section>

          <section className="setting" id="alerts">
            <h2>Email and alerts</h2>
            <p className="empty">
              Get an email when someone signs in from a new place, or when a job starts or stops failing. Sent with
              Resend.
            </p>
            <Fields fields={fields} saved={saved} asks={MAIL} />
          </section>

          <section className="setting" id="search">
            <h2>Web search</h2>
            <Fields fields={fields} saved={saved} asks={SEARCH} />
          </section>

          <section className="setting" id="owner">
            <h2>Owner</h2>
            <Fields fields={fields} saved={saved} asks={OWNER} />
          </section>
        </>
      )}

      <section className="setting" id="keys">
        <h2>Keys</h2>
        <Keys key={round} />
      </section>

      <section className="setting" id="file">
        <h2>chloe.config.ts</h2>
        <details>
          <summary>The file as text</summary>
          <Config key={round} loaded={refresh} />
        </details>
      </section>
    </>
  );
}

const MODELS: Ask[] = [
  {
    path: "model.defaultModel",
    label: "Default model",
    placeholder: "anthropic/claude-sonnet-5",
    about: "Used by any agent that does not pick its own.",
  },
  {
    path: "model.keys.anthropic",
    label: "Anthropic API key",
    kind: "secret",
    about: "Use Anthropic models with your own key, paid per call. Without one, Chloe uses Claude Code on your subscription.",
  },
  {
    path: "model.keys.openai",
    label: "OpenAI API key",
    kind: "secret",
    about: "The same for OpenAI models. Without one, Chloe uses Codex on your ChatGPT plan.",
  },
  { path: "model.key", label: "Gateway key", kind: "secret", about: "For a gateway that reaches any model." },
];

const MAIL: Ask[] = [
  {
    path: "email.provider",
    label: "Send mail with",
    kind: "choice",
    choices: [
      ["resend", "Resend"],
      ["gmail", "Gmail, as the Google account"],
      ["none", "Nothing: only write it to the log"],
    ],
  },
  { path: "connections.resend.api_key", label: "Resend API key", kind: "secret" },
  { path: "connections.resend.alerts", label: "Send alerts", kind: "switch" },
  { path: "connections.resend.email_to", label: "Alerts go to", placeholder: "you@example.com" },
  {
    path: "connections.resend.email_from",
    label: "Alerts come from",
    placeholder: "Chloe <alerts@example.com>",
    about: "Must be on a domain your Resend account can send from.",
  },
];

const SEARCH: Ask[] = [
  {
    path: "connections.brave.api_key",
    label: "Brave Search API key",
    kind: "secret",
    about: "Optional. Without one, Chloe searches DuckDuckGo, which can stop answering if you search a lot.",
  },
];

const OWNER: Ask[] = [
  {
    path: "owner",
    label: "Owner",
    placeholder: "telegram:123456789",
    about: "Who a job asks when it needs an answer. Leave it empty to use the first person each channel allows.",
  },
];

/**
 * What .env sets, by name, and a box to paste NAME=value lines into it. A
 * value is sent once and never shown again. `?key=NAME` in the address starts
 * the box with that name, which is how an agent sends its owner here.
 */
function Keys() {
  const [names, setNames] = useState<Key[] | null>(null);
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
        Passwords, keys and tokens are kept in <code>.env</code>. Paste lines like <code>CHLOE_SOMETHING=value</code>.
        A value is never shown again, here or to an agent. For Chloe to use one, <code>chloe.config.ts</code> must name
        it as <code>process.env.CHLOE_SOMETHING</code>.
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
            {names.map(({ name, inConfig }) => (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td className="dim aside">{inConfig ? "" : <>not handed over in <a href="#file">chloe.config.ts</a></>}</td>
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
 * chloe.config.ts as text, for the settings, the default model and the
 * process.env lines that hand keys over. The server loads and type checks a
 * save before it keeps it, so a mistake comes back as the reason and the file
 * stays as it was.
 */
function Config({ loaded }: { loaded: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [trouble, setTrouble] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api.config().then(
      (said) => {
        setText(said.text);
        setSaved(said.text);
      },
      () => setText(null),
    );
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (text === null) return;
    setTrouble("");
    setDone(false);
    setBusy(true);
    try {
      await api.saveConfig(text);
      setSaved(text);
      loaded();
      setDone(true);
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (text === null) return null;
  return (
    <>
      <p className="empty">
        For anything the forms above do not cover. Never put a key here: put it in Keys. If a save breaks something,
        the old file stays.
      </p>
      <form onSubmit={save}>
        <CodeEditor
          text={text}
          language="chloe.config.ts"
          onChange={(next) => {
            setText(next);
            setDone(false);
          }}
          label="chloe.config.ts"
        />
        <button className="small" type="submit" disabled={busy || text === saved}>
          {busy ? "Checking" : "Save"}
        </button>
      </form>
      {done && <p className="empty">Saved and loaded.</p>}
      {trouble && <pre className="bad">{trouble}</pre>}
    </>
  );
}

