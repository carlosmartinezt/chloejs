import { useCallback, useEffect, useState } from "react";

import { api, type Key } from "../lib/api.ts";
import type { Field, Sections } from "../lib/types.ts";
import { PANELS } from "../plugins.ts";
import { CodeEditor } from "./components/CodeEditor.tsx";
import { type Ask, Fields } from "./components/Fields.tsx";

/** The page's sections in the order chloe.config.ts says them, as the list down the left, each plugin's under Connections. */
function parts(sections: Sections | null): [id: string, title: string, inside?: boolean][] {
  return [
    ["model", "Model"],
    ["email", "Email"],
    ["connections", "Connections"],
    ...(sections?.sections ?? []).map((one): [string, string, boolean] => [one.id, one.title, true]),
    ["serve", "Serve"],
    ["owner", "Owner"],
    ["keys", "Keys"],
    ["file", "chloe.config.ts"],
  ];
}

/**
 * The whole copy's settings, as forms: what chloe.config.ts and .env say,
 * changed where they say it, in the order the file says them. A form changes
 * a plain value in the file, and a key goes into .env with the file naming it.
 * Anything the forms do not cover, or the file says as code, is the file
 * itself, at the bottom.
 */
export function Configuration() {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [sections, setSections] = useState<Sections | null>(null);
  const [trouble, setTrouble] = useState("");
  // The file as text is read again after a form saves, so the two never disagree.
  const [round, setRound] = useState(0);

  const refresh = useCallback(() => {
    api.fields().then(setFields, (error: Error) => setTrouble(error.message));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    api.sections().then(setSections, (error: Error) => setTrouble(error.message));
  }, []);

  const saved = (all: Field[]) => {
    setFields(all);
    setRound((n) => n + 1);
  };

  return (
    <div className="config">
      <nav className="config-nav" aria-label="Sections">
        {parts(sections).map(([id, title, inside]) => (
          <a key={id} href={`#${id}`} className={inside ? "inside" : undefined}>
            {title}
          </a>
        ))}
      </nav>

      <div>
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
            <section className="setting" id="model">
              <h2>Model</h2>
              <Fields fields={fields} saved={saved} asks={model(sections)} />
            </section>

            <section className="setting" id="email">
              <h2>Email</h2>
              <Fields fields={fields} saved={saved} asks={email(sections)} />
            </section>

            <hr className="part" />
            <section className="setting" id="connections">
              <h2>Connections</h2>
              <p className="empty">The outside services that tools and channels work through.</p>

              {sections?.sections.map((one) => {
                const Panel = PANELS[one.id];
                return (
                  <section className="setting" id={one.id} key={one.id}>
                    <h3>{one.title}</h3>
                    {one.about && <p className="empty">{one.about}</p>}
                    {one.fields.length > 0 && <Fields fields={fields} saved={saved} asks={one.fields} />}
                    {Panel && (
                      <Panel
                        done={() => {
                          refresh();
                          setRound((n) => n + 1);
                        }}
                      />
                    )}
                  </section>
                );
              })}
            </section>

            <hr className="part" />
            <section className="setting" id="serve">
              <h2>Serve</h2>
              <Fields fields={fields} saved={saved} asks={SERVE} />
            </section>

            <section className="setting" id="owner">
              <h2>Owner</h2>
              <Fields fields={fields} saved={saved} asks={OWNER} />
            </section>
          </>
        )}

        <hr className="part" />
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
      </div>
    </div>
  );
}

/** The model's settings, with the ways to reach a model this copy has. */
const model = (sections: Sections | null): Ask[] => [
  {
    path: "model.defaultModel",
    label: "Default model",
    placeholder: "anthropic/claude-sonnet-5.5",
    about: "Used by any agent that does not pick its own.",
  },
  {
    path: "model.preferredRoute",
    label: "Ways to reach a model, in order",
    kind: "list",
    placeholder: (sections?.routes ?? ["direct", "gateway"]).join(", "),
    about: `Each call takes the first one that can run the model and is set up here. Any of ${(sections?.routes ?? ["direct", "gateway"]).join(", ")}. Empty is all of them, in that order.`,
  },
  {
    path: "model.models",
    label: "Models to pick from",
    kind: "list",
    placeholder: "anthropic/claude-sonnet-5.5, openai/gpt-5.5",
    about: "What /models in a chat offers. Empty lists every model this machine can reach.",
  },
  {
    path: "model.keys.anthropic",
    label: "Anthropic API key",
    kind: "secret",
    about: "Use Anthropic models with your own key, paid per call.",
  },
  {
    path: "model.keys.openai",
    label: "OpenAI API key",
    kind: "secret",
    about: "The same for OpenAI models.",
  },
  { path: "model.key", label: "Gateway key", kind: "secret", about: "For a gateway that reaches any model." },
  {
    path: "model.gatewayUrl",
    label: "Gateway address",
    placeholder: "https://ai-gateway.vercel.sh/v1/chat/completions",
    about: "Any gateway that takes OpenAI-style requests. It ends in /chat/completions.",
  },
  {
    path: "model.timeLimit",
    label: "Longest call, in minutes",
    kind: "number",
    about: "A call still going then is stopped and its run fails. 0 is no limit.",
  },
  {
    path: "model.namingModel",
    label: "Model that names a chat",
    placeholder: "anthropic/claude-haiku-4.5",
    about: "Gives each new chat a short name from its first message.",
  },
  {
    path: "model.judgeModel",
    label: "Model that grades evals",
    placeholder: "anthropic/claude-sonnet-5.5",
  },
];

/** How mail is sent, from the services this copy's plugins send through. */
const email = (sections: Sections | null): Ask[] => [
  {
    path: "email.provider",
    label: "Send mail with",
    kind: "choice",
    choices: sections?.emailProviders ?? [["none", "Nothing: only write it to the log"]],
    about: "For a job that sends mail without naming a service.",
  },
];

const SERVE: Ask[] = [
  {
    path: "serve.url",
    label: "Address of this page",
    placeholder: "https://chloe.example.com",
    about:
      "Where this page is opened from other machines, so an agent can send a link to a file. Where the server listens is changed in the file, because a wrong one loses this page.",
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
          placeholder="CHLOE_SOMETHING=..."
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

