import { useCallback, useEffect, useState } from "react";

import { api, call } from "../../../site/lib/api.ts";
import { copy } from "../../../site/lib/copy.ts";
import type { Field } from "../../../site/lib/types.ts";
import { Link } from "../../../site/views/components/Link.tsx";
import { SignIn } from "../../../site/views/components/SignIn.tsx";

/** Where Google stands, from /api/google. */
interface GoogleState {
  ready: boolean;
  account: string;
  /** What is missing, in plain words. Empty when nothing is. */
  missing: string;
  /** A sign-in was started and waits for its answer. */
  waiting: boolean;
}

/** The plugin's routes, which the page reaches like any other. */
const google = {
  /** Whether Google can be reached, and what is missing. */
  state: () => call<GoogleState>("/google"),
  /** The steps in Google's console, and the redirect addresses to give the client. */
  setup: () => call<{ why: string; steps: string[]; addresses: string[] }>("/google/setup"),
  /** Signing in to Google from the page, without an agent: what to tell the person and the link to open. */
  start: () => call<{ say: string; link?: string }>("/google/sign-in", {}),
  finish: async (answer: string) => `Signed in to Google as ${(await call<{ account: string }>("/google/finish", { answer })).account}.`,
};

const CLIENT = "connections.google.client";
const ACCOUNT = "connections.google.account";
const CONSOLE = "https://console.cloud.google.com";

/**
 * Setting up Google, step by step, each marked done from what the runtime can
 * see: a client made in Google's console, its file pasted here (into .env,
 * named in chloe.config.ts), the account, and the sign-in. The same panel on
 * Configuration and on an agent's Connections, because people look for it on
 * the agent while it is set once for the whole copy. Once signed in it folds
 * away, and opens again to change the client or the account.
 */
export function GoogleSetup({ onAgent, done }: { onAgent?: boolean; done?: () => void }) {
  const [state, setState] = useState<GoogleState | null>(null);
  const [fields, setFields] = useState<Field[] | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState("");
  const [account, setAccount] = useState("");
  const [trouble, setTrouble] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  const refresh = useCallback(() => {
    google.state().then(setState, () => setState(null));
    api.fields().then(
      (all) => {
        setFields(all);
        const said = all.find((one) => one.path === ACCOUNT)?.value;
        setAccount(typeof said === "string" ? said : "");
      },
      (error: Error) => setTrouble(error.message),
    );
  }, []);

  useEffect(() => {
    refresh();
    google.setup().then((said) => setAddresses(said.addresses), () => setAddresses([]));
  }, [refresh]);

  async function save(path: string, value: string) {
    setTrouble("");
    setBusy(true);
    try {
      setFields(await api.changeSettings([{ path, value }]));
      if (path === CLIENT) setFile("");
      google.state().then(setState, () => undefined);
      done?.();
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const finished = () => {
    refresh();
    setOpen(false);
    done?.();
  };

  if (!fields) return trouble ? <p className="bad">{trouble}</p> : null;

  const client = fields.find((one) => one.path === CLIENT);
  const named = fields.find((one) => one.path === ACCOUNT);
  const signedIn = Boolean(state?.ready);
  const key = client?.key ?? "CHLOE_CONNECTIONS_GOOGLE_CLIENT";

  if (signedIn && !open) {
    return (
      <div className="guide">
        <p className="empty">Signed in as {state?.account}.</p>
        <span className="buttons">
          <SignIn name="google" again whole={google} done={finished} />
          <button className="small plain" onClick={() => setOpen(true)}>
            Change the Google project or account
          </button>
        </span>
      </div>
    );
  }

  const link = (path: string, words: string) => (
    <a href={`${CONSOLE}/${path}`} target="_blank" rel="noopener noreferrer">
      {words}
    </a>
  );
  const tick = (yes: boolean | undefined) => (yes ? <span className="state free">Done</span> : null);

  return (
    <div className="guide">
      {onAgent && (
        <p className="empty">
          This is for every agent. You can also do it in <Link to={{ at: "configuration" }}>Configuration</Link>.
        </p>
      )}
      <ol className="steps">
        <li>Create a Google Cloud project {link("projectcreate", "here")}.</li>
        <li>
          Turn on the {link("apis/library/gmail.googleapis.com", "Gmail API")}, the{" "}
          {link("apis/library/calendar-json.googleapis.com", "Google Calendar API")} and the{" "}
          {link("apis/library/drive.googleapis.com", "Google Drive API")}.
        </li>
        <li>
          Fill in the {link("auth/branding", "app name")} and pick External. In {link("auth/audience", "Audience")}, add your
          Google account as a test user. Press Publish app there when it works: in Testing, Google signs you out every 7
          days.
        </li>
        <li>
          {link("auth/clients/create", "Create a client")} of type Web application, with these redirect URIs:
          <ul className="addresses">
            {addresses.map((address) => (
              <li key={address}>
                <code>{address}</code>
                <button
                  type="button"
                  className="small plain"
                  onClick={() => void copy(address).then((worked) => setCopied(worked ? address : ""))}
                >
                  {copied === address ? "Copied" : "Copy"}
                </button>
              </li>
            ))}
          </ul>
        </li>
        <li>
          Download the client JSON and paste it here. It is saved in <code>.env</code> as <code>{key}</code>. {tick(client?.set)}
          {client?.written === "code" ? (
            <p className="dim">chloe.config.ts sets this in code, so change it there.</p>
          ) : (
            <>
              <textarea
                rows={3}
                spellCheck={false}
                autoComplete="off"
                value={file}
                onChange={(event) => setFile(event.target.value)}
                placeholder={client?.set ? "Saved. Paste a new one to replace it." : '{"web":{"client_id":"...'}
                aria-label="The client JSON"
              />
              <span className="buttons">
                <input
                  type="file"
                  accept=".json,application/json"
                  aria-label="Or choose the file"
                  onChange={(event) => void event.target.files?.[0]?.text().then(setFile)}
                />
                <button className="small" disabled={busy || !file.trim()} onClick={() => void save(CLIENT, file)}>
                  Save
                </button>
              </span>
            </>
          )}
        </li>
        <li>
          Your Google account. It is saved in <code>chloe.config.ts</code>. {tick(named?.set)}
          {named?.written === "code" ? (
            <p className="dim">chloe.config.ts sets this in code, so change it there.</p>
          ) : (
            <span className="buttons">
              <input type="email" value={account} onChange={(event) => setAccount(event.target.value)} placeholder="you@gmail.com" />
              <button
                className="small"
                disabled={busy || !account.trim() || account.trim() === named?.value}
                onClick={() => void save(ACCOUNT, account.trim())}
              >
                Save
              </button>
            </span>
          )}
        </li>
        <li>
          When you are ready, open the sign-in page. {tick(signedIn)}
          {client?.set && named?.set ? (
            <SignIn name="google" again={signedIn} whole={google} done={finished} />
          ) : (
            <p className="dim">Save the client JSON and your account first.</p>
          )}
        </li>
      </ol>
      {trouble && <pre className="bad">{trouble}</pre>}
      {signedIn && (
        <button className="small plain" onClick={() => setOpen(false)}>
          Close
        </button>
      )}
    </div>
  );
}
