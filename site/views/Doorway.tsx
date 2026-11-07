import { useEffect, useState } from "react";

import * as Icons from "./components/Icons.tsx";
import { api } from "../lib/api.ts";
import { linkTrouble } from "../lib/link.ts";
import { afterSignIn } from "../lib/route.ts";

/**
 * The way in: an email and a password, for the owner and for somebody they
 * invited alike, and the server works out which. A copy with no password opens
 * for its owner only with a link, so this says how to get one, and the first
 * password is set in Account settings, once in. Somebody invited who has
 * forgotten theirs asks here for a link by mail, when the copy can send one.
 */
export function Doorway({ making }: { making: boolean }) {
  const [invited, setInvited] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState(linkTrouble);
  const [shown, setShown] = useState(false);
  // Whether a forgotten password can be mailed a link, which the server says before anybody is in.
  const [mails, setMails] = useState(false);
  const [forgot, setForgot] = useState(false);
  // The address a link was asked for, once it was.
  const [asked, setAsked] = useState("");

  useEffect(() => {
    api.canMailPassword().then((said) => setMails(said.mails), () => undefined);
  }, []);

  async function askForLink(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !email.trim()) return;
    setSending(true);
    setTrouble("");
    try {
      await api.forgotPassword(email.trim());
      setAsked(email.trim());
    } catch (error) {
      setTrouble((error as Error).message);
    }
    setSending(false);
  }

  if (forgot) {
    return (
      <main className="doorway">
        {mark}
        <h1>Reset your password</h1>
        {trouble && <p className="bad">{trouble}</p>}
        {asked ? (
          <p className="empty">
            If {asked} was invited here, a link to choose a new password is on its way to it. It works once, for a day.
          </p>
        ) : mails ? (
          <form onSubmit={askForLink}>
            <label>
              Email
              <input value={email} type="email" autoComplete="username" autoFocus onChange={(event) => setEmail(event.target.value)} />
            </label>
            <button type="submit" disabled={sending || !email.trim()}>
              Email me a link
            </button>
          </form>
        ) : (
          <p className="empty">Ask whoever invited you for a password link.</p>
        )}
        <p className="empty">
          If this is your own copy, run <code>npx chloe account</code> in its folder. It sets a new password and loses nothing.
        </p>
        <p className="swap">
          <button type="button" className="plain" onClick={() => (setForgot(false), setAsked(""), setTrouble(""))}>
            Back to signing in
          </button>
        </p>
      </main>
    );
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setTrouble("");
    try {
      await api.signIn(email.trim(), password);
      // A whole load rather than a view change: the page is fetching everything
      // it shows anyway, and it has none of it yet.
      window.location.assign(afterSignIn());
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
          Once in, My account is where to set a password, if you want one.
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
      <h1>Welcome back</h1>
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={send}>
        <label>
          Email
          {/* Not type="email": an owner may have chosen a name that is no address. */}
          <input
            value={email}
            type="text"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            autoFocus
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <span className="peek">
            <input
              value={password}
              type={shown ? "text" : "password"}
              autoComplete="current-password"
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
        <p className="swap">
          <button type="button" className="plain" onClick={() => (setForgot(true), setTrouble(""))}>
            Forgot password?
          </button>
        </p>
        <button type="submit" disabled={sending || !password}>
          Continue
        </button>
      </form>
    </main>
  );
}

export const mark = (
  <p className="mark">
    <span className="glyph" />
    Chloe
  </p>
);
