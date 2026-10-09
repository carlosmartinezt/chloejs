import { useState } from "react";

import * as Icons from "./components/Icons.tsx";
import { api } from "../lib/api.ts";
import { linkTrouble } from "../lib/link.ts";

/**
 * The way in: a link the runtime printed, or the owner's password with no
 * username, because there is one owner. Somebody the owner invited signs in
 * with their email and their own password, from the same form once they say
 * so: `?invited` in the address opens it that way. A copy with no password
 * opens only with a link, so this says how to get one; the first password is
 * set in Account settings, once in.
 */
export function Doorway({ making }: { making: boolean }) {
  const [invited, setInvited] = useState(() => new URLSearchParams(window.location.search).has("invited"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState(linkTrouble);
  const [shown, setShown] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setTrouble("");
    try {
      await api.signIn(password, invited ? email.trim() : undefined);
      // A whole load rather than a view change: the page is fetching everything
      // it shows anyway, and it has none of it yet.
      window.location.assign("/");
    } catch (error) {
      setTrouble((error as Error).message);
      setSending(false);
    }
  }

  // Somebody invited signs in with their own password, whether or not the owner has one.
  if (making && !invited) {
    return (
      <main className="doorway">
        {mark}
        <h1>Open it with a link</h1>
        {trouble && <p className="bad">{trouble}</p>}
        <p className="empty">
          This copy has no password, so it opens with a link that signs this browser in. In its folder, run{" "}
          <code>npx chloe link</code> and open what it prints. Starting it with <code>npx chloe</code> prints one too.
          Once in, Account settings is where to set a password, if you want one.
        </p>
        <p className="swap">
          <button type="button" className="plain" onClick={() => setInvited(true)}>
            Invited by somebody? Sign in with your email
          </button>
        </p>
      </main>
    );
  }

  return (
    <main className="doorway">
      {mark}
      <h1>Sign in</h1>
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={send}>
        {invited && (
          <label>
            Email
            <input
              value={email}
              type="email"
              autoComplete="username"
              autoFocus
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        )}
        <label>
          Password
          <span className="peek">
            <input
              value={password}
              type={shown ? "text" : "password"}
              autoComplete="current-password"
              autoFocus={!invited}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="show"
              aria-pressed={shown}
              aria-label={shown ? "Hide the password" : "Show the password"}
              title={shown ? "Hide the password" : "Show the password"}
              onClick={() => setShown(!shown)}
            >
              {shown ? <Icons.EyeOff /> : <Icons.Eye />}
            </button>
          </span>
        </label>
        <button type="submit" disabled={sending || !password || (invited && !email.trim())}>
          Sign in
        </button>
      </form>
      {invited ? (
        <p className="empty">
          With the email you were invited with, and the password you chose then. Forgotten it? Ask whoever
          invited you.
        </p>
      ) : (
        <p className="empty">
          Or open it with a link: run <code>npx chloe link</code> in its folder and open what it prints. Forgotten the
          password is <code>npx chloe account</code> there, which sets a new one and loses nothing.
        </p>
      )}
      <p className="swap">
        <button type="button" className="plain" onClick={() => (setInvited(!invited), setTrouble(""))}>
          {invited ? "This is my own Chloe" : "Invited by somebody? Sign in with your email"}
        </button>
      </p>
    </main>
  );
}

export const mark = (
  <p className="mark">
    <span className="glyph" />
    Chloe
  </p>
);
