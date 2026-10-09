import { useEffect, useState } from "react";

import * as Icons from "./components/Icons.tsx";
import { mark } from "./Doorway.tsx";
import { api } from "../lib/api.ts";
import { href } from "../lib/route.ts";
import type { Invitation as Invited, Switch } from "../lib/types.ts";

/** What each switch lets the person reading this do, said to them. */
const YOU_MAY: Record<Switch, string> = {
  chat: "talk to it, in conversations of your own",
  read: "see the runs you started",
  run: "start its jobs",
};

/**
 * The page an invitation's link opens, signed in or not. It says which agent
 * it is for and to whom, and taking it signs this browser in as that person:
 * somebody new chooses a password here, somebody already invited to another
 * agent gives the one they have.
 */
export function Invitation({ code }: { code: string }) {
  const [found, setFound] = useState<Invited | null>(null);
  const [gone, setGone] = useState(false);
  const [owner, setOwner] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState("");

  useEffect(() => {
    api.invitation(code).then(
      (one) => {
        setFound(one);
        setName(one.name);
      },
      () => setGone(true),
    );
    // Taking it replaces whatever session this browser has, so the owner trying
    // their own link is told before they lose theirs.
    api.me().then((who) => setOwner(who.owner), () => {});
  }, [code]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !found) return;
    setSending(true);
    setTrouble("");
    try {
      await api.accept(code, password, name.trim());
      // A whole load: the page has nothing of this person's yet.
      window.location.assign(found.given.includes("chat") ? href({ at: "chat", agent: found.agent }) : "/");
    } catch (error) {
      setTrouble((error as Error).message);
      setSending(false);
    }
  }

  if (gone) {
    return (
      <main className="doorway">
        {mark}
        <h1>This invitation cannot be used</h1>
        <p className="empty">
          It has been used already, or the week it was good for is over. Ask whoever sent it for a new one. If you took it
          already, <a href="/login?invited">sign in with your email</a>.
        </p>
      </main>
    );
  }

  if (!found) return <main className="doorway">{mark}</main>;

  const short = !found.known && password.length < 8;

  return (
    <main className="doorway">
      {mark}
      <h1>You have been invited to {found.label}</h1>
      <p className="empty">
        You may {found.given.map((one) => YOU_MAY[one]).join(", and ")}.
      </p>
      {owner && (
        <p className="bad">
          This browser is signed in as the owner. Taking this invitation signs it in as {found.email} instead.
        </p>
      )}
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={send}>
        <label>
          Email
          <input value={found.email} type="email" autoComplete="username" readOnly />
        </label>
        {!found.known && (
          <label>
            Your name
            <input value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        <label>
          {found.known ? "The password you already have here" : "Choose a password, at least 8 characters"}
          <span className="peek">
            <input
              value={password}
              type={shown ? "text" : "password"}
              autoComplete={found.known ? "current-password" : "new-password"}
              autoFocus
              minLength={found.known ? undefined : 8}
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
        <button type="submit" disabled={sending || !password || short}>
          {found.known ? "Sign in and take it" : "Take the invitation"}
        </button>
      </form>
      <p className="empty">
        {found.known
          ? "You were invited here before, so this adds the agent to what you have."
          : "From now on you sign in with this email and this password."}
      </p>
    </main>
  );
}
