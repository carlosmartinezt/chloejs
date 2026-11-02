import { useEffect, useState } from "react";

import * as Icons from "./components/Icons.tsx";
import { mark } from "./Doorway.tsx";
import { api } from "../lib/api.ts";

/**
 * The page a password link opens, signed in or not: somebody the owner
 * invited chooses a new password here, and is signed in with it.
 */
export function NewPassword({ code }: { code: string }) {
  const [found, setFound] = useState<{ email: string; name: string } | null>(null);
  const [gone, setGone] = useState(false);
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    api.passwordFor(code).then(setFound, () => setGone(true));
  }, [code]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !found) return;
    setSending(true);
    setTrouble("");
    try {
      await api.newPassword(code, password);
      // A whole load: the page has nothing of this person's yet.
      window.location.assign("/");
    } catch (error) {
      setTrouble((error as Error).message);
      setSending(false);
    }
  }

  if (gone) {
    return (
      <main className="doorway">
        {mark}
        <h1>This link cannot be used</h1>
        <p className="empty">
          It has been used already, or the day it was good for is over. Ask whoever sent it for a new one, or{" "}
          <a href="/login?invited">sign in with your email</a>.
        </p>
      </main>
    );
  }

  if (!found) return <main className="doorway">{mark}</main>;

  return (
    <main className="doorway">
      {mark}
      <h1>Choose a new password</h1>
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={send}>
        <label>
          Email
          <input value={found.email} type="email" autoComplete="username" readOnly />
        </label>
        <label>
          A new password, at least 8 characters
          <span className="peek">
            <input
              value={password}
              type={shown ? "text" : "password"}
              autoComplete="new-password"
              autoFocus
              minLength={8}
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
        <button type="submit" disabled={sending || password.length < 8}>
          Set it and sign in
        </button>
      </form>
      <p className="empty">From now on you sign in with this email and this password. The old one stops working.</p>
    </main>
  );
}
