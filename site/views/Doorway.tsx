import { useEffect, useState } from "react";

import * as Icons from "./components/Icons.tsx";
import { api, cloud } from "../lib/api.ts";
import type { Invitation, Signup } from "../lib/types.ts";
import { Link } from "./components/Link.tsx";

/**
 * The way in, for all three kinds of server this page sits in front of.
 *
 * One runtime: one password and no username, because with one account a name
 * identifies nobody. The same form sets it when that copy has none yet, and
 * once one is set that form is not offered again.
 *
 * A cloud: an email and a password, because a cloud has many people on it, and
 * making an account is its own form, which needs an invite code while the
 * cloud says so. That one is also the first page anybody who follows a link
 * here ever sees, so it says what is behind it before it asks for anything.
 *
 * An invitation's link opens the account form with `?invitation=`. Somebody
 * who has an account already signs in from the same page instead, and is let
 * in as they do; somebody already signed in is asked to accept it.
 */
export function Doorway({ making, onCloud, signup }: { making: boolean; onCloud: boolean; signup: Signup }) {
  const [who, setWho] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState("");
  const [shown, setShown] = useState(false);
  // An invitation an owner mailed: it says who it is for, and is the invite code.
  const [invited, setInvited] = useState<Invitation | null>(null);
  // With an invitation: the account this browser is signed in to already, and
  // whether the person said they have one and want to sign in to it.
  const [account, setAccount] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const makingNow = invited ? !signingIn : making;

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invitation");
    if (!onCloud || !making || !code) return;
    cloud.invitation(code).then(
      (found) => {
        setInvited(found);
        setWho(found.email);
        setInvite(code);
        cloud.me().then(
          (me) => setAccount(me.email),
          () => {},
        );
      },
      () => setTrouble("That invitation is used, out of date, or was never sent. Ask whoever sent it for a new one."),
    );
  }, [onCloud, making]);

  const needsInvite = onCloud && makingNow && signup === "invite" && !invited;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setTrouble("");
    try {
      if (onCloud) {
        await (makingNow ? cloud.signUp(who, password, invite) : cloud.signIn(who, password));
        if (invited && !makingNow) await cloud.accept(invite);
      } else await (making ? api.setup(password) : api.signIn(password));
      // A whole load rather than a view change: the page is fetching everything
      // it shows anyway, and it has none of it yet.
      window.location.assign("/");
    } catch (error) {
      setTrouble((error as Error).message);
      setSending(false);
    }
  }

  const form = (
    <>
      <h1>{makingNow ? (onCloud ? "Create an account" : "Choose a password") : "Sign in"}</h1>
      {making && !onCloud && (
        <p className="empty">
          This copy has no password yet. Anything else running on this machine can reach this port, so chloe asks for
          one before it shows the agents, their runs and the folders they keep. It stays on this machine, and signing in
          lasts a week. Forgotten it later is <code>npx chloe account</code> in a terminal, which sets a new one and
          loses nothing.
        </p>
      )}
      {invited && (
        <p className="empty">
          {invited.by} invited you to use {invited.agent} in {invited.workspace}.{" "}
          {makingNow
            ? "Make your account with this address and it is there when you sign in."
            : "Sign in to the account you have with this address and it is added to it."}
        </p>
      )}
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={send}>
        {onCloud && (
          <label>
            Email
            <input
              value={who}
              type="email"
              autoComplete="email"
              autoFocus={!invited}
              readOnly={Boolean(invited)}
              onChange={(event) => setWho(event.target.value)}
            />
          </label>
        )}
        <label>
          Password
          <span className="peek">
            <input
              value={password}
              type={shown ? "text" : "password"}
              autoComplete={makingNow ? "new-password" : "current-password"}
              autoFocus={!onCloud}
              minLength={makingNow ? 8 : undefined}
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
        {needsInvite && (
          <label>
            Invite code
            <input value={invite} placeholder="chloe-..." onChange={(event) => setInvite(event.target.value)} />
          </label>
        )}
        <button
          type="submit"
          disabled={sending || !password || (onCloud && !who.trim()) || (needsInvite && !invite.trim())}
        >
          {makingNow ? (onCloud ? "Create account" : "Set password") : "Sign in"}
        </button>
      </form>
      {invited && (
        <p className="swap">
          {makingNow ? "Already have an account with this address? " : "No account yet? "}
          <button type="button" className="plain" onClick={() => setSigningIn(makingNow)}>
            {makingNow ? "Sign in" : "Make one"}
          </button>
        </p>
      )}
      {onCloud && !invited && (
        <p className="swap">
          {making ? (
            <>
              Already have one? <Link to={{ at: "signin", making: false }}>Sign in</Link>
            </>
          ) : signup === "closed" ? (
            "Accounts here are made by whoever runs this."
          ) : (
            <>
              No account yet? <Link to={{ at: "signin", making: true }}>Register</Link>
            </>
          )}
        </p>
      )}
    </>
  );

  if (!onCloud) return <main className="doorway">{mark}{form}</main>;

  const taking = invited && account && (
    <>
      <h1>{account === invited.email ? "Accept the invitation" : "Another account"}</h1>
      {trouble && <p className="bad">{trouble}</p>}
      {account === invited.email ? (
        <>
          <p className="empty">
            {invited.by} invited you to use {invited.agent} in {invited.workspace}.
          </p>
          <button
            disabled={sending}
            onClick={() => {
              setSending(true);
              cloud.accept(invite).then(
                () => window.location.assign("/"),
                (error: Error) => {
                  setTrouble(error.message);
                  setSending(false);
                },
              );
            }}
          >
            Accept
          </button>
        </>
      ) : (
        <>
          <p className="empty">
            This invitation is for {invited.email}, and you are signed in as {account}. Sign out, then open the link
            again.
          </p>
          <button onClick={() => void cloud.signOut().then(() => window.location.reload())}>Sign out</button>
        </>
      )}
    </>
  );

  return (
    <main className="gate">
      <div className="gate-in">
        <Pitch making={making} />
        <section className="gate-card">
          {taking || form}
          {making && signup !== "open" && !invited && <Waitlist />}
        </section>
      </div>
      <p className="gate-foot">
        Chloe is an open source TypeScript agent runtime. <a href="https://chloejs.org">chloejs.org</a>
      </p>
    </main>
  );
}

const mark = (
  <p className="mark">
    <span className="glyph" />
    Chloe
  </p>
);

/** What is behind the login, for somebody who has arrived from a link and has never seen it. */
function Pitch({ making }: { making: boolean }) {
  return (
    <section className="gate-pitch">
      {mark}
      <h2>Every agent you run, on one page.</h2>
      <p className="lede">
        Your agents run on your own machine, with any LLM, and their files are yours. This is the window onto them:
        what each one did, what it said, what it cost, and the notes it keeps.
      </p>
      <ul className="points">
        <li>
          <b>Every run, start to finish</b>
          Each job, each step it took, what it replied and what it spent. The ones running now, and the ones that went
          wrong.
        </li>
        <li>
          <b>Your machine stays yours</b>
          The runtime opens one connection out to here. Nothing here dials in, so there is no port to open and no
          certificate to get. Take the key out of its settings and it runs exactly as before.
        </li>
        <li>
          <b>What it remembers is not kept here</b>
          A note is passed through and forgotten. Your runtime writes down every file it serves before it serves it, so
          the record of what was read is on your own disk.
        </li>
      </ul>
      {!making && <p className="lede quiet">One page for every machine you run Chloe on.</p>}
    </section>
  );
}

/**
 * For somebody with no invite code. It leaves an address with whoever runs the
 * cloud and nothing else: there is no position, no queue and no mail back until
 * a person sends one.
 */
function Waitlist() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState(false);
  const [trouble, setTrouble] = useState("");

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setTrouble("");
    try {
      await cloud.waitlist(email);
      setAsked(true);
    } catch (error) {
      setTrouble((error as Error).message);
    }
    setSending(false);
  }

  return (
    <div className="waitlist">
      <h3>No invite code?</h3>
      {asked ? (
        <p className="empty">
          Got it. Your code comes by email when the next batch goes out. Nothing else is done with the address.
        </p>
      ) : (
        <>
          <p className="empty">
            Chloe Cloud is invite only while it is new. Leave your email and a code comes back when the next batch goes
            out.
          </p>
          {trouble && <p className="bad">{trouble}</p>}
          <form onSubmit={send}>
            <label>
              Email
              <input
                value={email}
                type="email"
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button type="submit" className="quiet" disabled={sending || !email.trim()}>
              {sending ? "Sending" : "Join the waitlist"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
