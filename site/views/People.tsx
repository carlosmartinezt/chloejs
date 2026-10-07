import { useCallback, useEffect, useState } from "react";

import { cloud, NeedsSignIn } from "../lib/api.ts";
import { ZONE } from "../lib/format.ts";
import { go } from "../lib/route.ts";
import type { Given, People as Everybody, Workspace } from "../lib/types.ts";

/** Each thing a guest can be given: a short name for its toggle, and what it means. */
const SWITCHES: { given: Given; short: string; long: string; means: string }[] = [
  { given: "chat", short: "Chat", long: "Chat", means: "Talk to it. Its tools work for them as they do for you." },
  { given: "read", short: "Runs", long: "See its runs and setup", means: "Its log, its jobs, its instructions and skills." },
  { given: "run", short: "Run jobs", long: "Run its jobs", means: "Start a job now, rather than waiting for its clock." },
  { given: "memory", short: "Memory", long: "Read its memory", means: "Open what it keeps. Every file they read is logged." },
];

/** "2 Oct": the day, where the box is. */
const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { timeZone: ZONE, day: "numeric", month: "short" });

/** One or two letters for the circle, out of the name or the part of the address before the @. */
const initials = (called: string): string => {
  const parts = called.split(/[\s.\-_+]/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
};

/**
 * A workspace's people, a page of its own: who its owner has let in to its
 * agents, grouped by agent, with what each may do as toggles, and a card to
 * invite somebody else. Everybody is mailed an invitation, account or not, and
 * the link goes nowhere else: if the mail does not arrive, invite them again.
 */
export function People({ workspace }: { workspace: Workspace }) {
  const [people, setPeople] = useState<Everybody | null>(null);
  const [trouble, setTrouble] = useState("");
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPeople(await cloud.people(workspace.name));
    } catch (error) {
      if (error instanceof NeedsSignIn) return go({ at: "signin", making: false });
      setTrouble((error as Error).message);
    }
  }, [workspace.name]);

  useEffect(() => void refresh(), [refresh]);

  async function tried(what: () => Promise<unknown>) {
    setBusy(true);
    try {
      await what();
      setTrouble("");
    } catch (error) {
      setTrouble((error as Error).message);
    }
    setBusy(false);
    await refresh();
  }

  const rows = [
    ...(people?.guests ?? []).map((one) => ({ ...one, invited: false, state: `Joined ${day(one.added)}` })),
    ...(people?.invited ?? []).map((one) => ({ ...one, name: "", invited: true, state: `Invited, until ${day(one.expires)}` })),
  ];
  const agents = [...new Set(rows.map((one) => one.agent))].sort();

  return (
    <>
      <div className="head">
        <h1>People</h1>
        {!inviting && workspace.agents.length > 0 && (
          <span className="actions">
            <button className="go small" onClick={() => setInviting(true)}>
              Invite someone
            </button>
          </span>
        )}
      </div>
      <p className="empty">
        Let somebody use one of {workspace.label}&rsquo;s agents. They see only that agent, and their conversations are
        their own, which you can read.
      </p>

      {trouble && <p className="bad">{trouble}</p>}

      {inviting && <Invite workspace={workspace} done={() => setInviting(false)} sent={refresh} />}

      {!people ? (
        <p className="dim">Loading</p>
      ) : rows.length === 0 ? (
        !inviting && (
          <p className="empty frame">
            {workspace.agents.length
              ? "Nobody yet. Invite someone to let them use one agent."
              : "Its runtime has not said which agents it has yet, so there is nothing to invite anybody to."}
          </p>
        )
      ) : (
        agents.map((agent) => (
          <section key={agent}>
            <h2 className="group">{agent}</h2>
            <ul className="rows">
              {rows
                .filter((one) => one.agent === agent)
                .map((one) => (
                  <li key={one.email}>
                    <span className={one.invited ? "face waiting" : "face"} aria-hidden="true">
                      {initials(one.name || one.email.split("@")[0])}
                    </span>
                    <span className="who">
                      <b>{one.name || one.email}</b>
                      <span>
                        {one.name ? `${one.email} · ` : ""}
                        {one.state}
                      </span>
                    </span>
                    <span className="pills" role="group" aria-label={`What ${one.email} may do`}>
                      {SWITCHES.map((each) => {
                        const on = one.given.includes(each.given);
                        return (
                          <button
                            key={each.given}
                            className="pill"
                            aria-pressed={on}
                            title={`${each.long}: ${each.means}`}
                            disabled={busy || (on && one.given.length === 1)}
                            onClick={() =>
                              void tried(() =>
                                cloud.change(
                                  workspace.name,
                                  one.email,
                                  one.agent,
                                  on ? one.given.filter((given) => given !== each.given) : [...one.given, each.given],
                                ),
                              )
                            }
                          >
                            {each.short}
                          </button>
                        );
                      })}
                    </span>
                    <button
                      className="plain small"
                      disabled={busy}
                      onClick={() => {
                        const what = one.invited ? `Cancel the invitation to ${one.email}?` : `Take ${one.email} off ${one.agent}? They lose it at once.`;
                        if (window.confirm(what)) void tried(() => cloud.letGo(workspace.name, one.email, one.agent));
                      }}
                    >
                      {one.invited ? "Cancel" : "Remove"}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

/** The card for inviting somebody: who, to which agent, and what they may do there. */
function Invite({ workspace, done, sent }: { workspace: Workspace; done: () => void; sent: () => unknown }) {
  const [email, setEmail] = useState("");
  const [agent, setAgent] = useState(workspace.agents[0] ?? "");
  const [given, setGiven] = useState<Given[]>(["chat"]);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const who = email.trim();
    if (!who || !agent || !given.length) return;
    setBusy(true);
    try {
      await cloud.letIn(workspace.name, who, agent, given);
      setAnswer(who);
      setTrouble("");
      await sent();
    } catch (error) {
      setTrouble((error as Error).message);
    }
    setBusy(false);
  }

  if (answer) {
    return (
      <section className="ready">
        <header>
          <div>
            <h2>Invitation sent to {answer}</h2>
            <p className="dim">
              It is good for a week. They make an account from the link, or sign in to the one they have. If the mail
              does not arrive, invite them again.
            </p>
          </div>
        </header>
        <div className="buttons">
          <button
            className="small"
            onClick={() => {
              setAnswer(null);
              setEmail("");
            }}
          >
            Invite someone else
          </button>
          <button className="plain small" onClick={done}>
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ready">
      <header>
        <div>
          <h2>Invite someone</h2>
          <p className="dim">With no account yet, they are mailed a link to make one. With one, they are in at once.</p>
        </div>
      </header>
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={send}>
        <div className="fields">
          <label>
            Email
            <input value={email} type="email" autoFocus placeholder="name@example.com" onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Agent
            <select value={agent} onChange={(event) => setAgent(event.target.value)}>
              {workspace.agents.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="switches">
          <legend>What they can do</legend>
          {SWITCHES.map((each) => (
            <label key={each.given}>
              <input
                type="checkbox"
                checked={given.includes(each.given)}
                onChange={() =>
                  setGiven(given.includes(each.given) ? given.filter((one) => one !== each.given) : [...given, each.given])
                }
              />
              <span>
                <b>{each.long}</b>
                <span>{each.means}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="buttons">
          <button className="go small" type="submit" disabled={busy || !email.trim() || !given.length}>
            {busy ? "Sending" : "Send invitation"}
          </button>
          <button className="plain small" type="button" onClick={done}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
