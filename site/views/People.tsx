import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import { copy } from "../lib/copy.ts";
import { labelOf, ZONE } from "../lib/format.ts";
import type { AgentSummary, People as Everybody, Switch } from "../lib/types.ts";

/** Each thing somebody can be given on an agent: a short name for its toggle, and what it means. */
const SWITCHES: { given: Switch; short: string; means: string }[] = [
  { given: "chat", short: "Chat", means: "Talk to it, in conversations of their own." },
  { given: "read", short: "Read", means: "See the runs they started." },
  { given: "run", short: "Run", means: "Start its jobs." },
];

/** "2 Oct": the day, where the box is. */
const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { timeZone: ZONE, day: "numeric", month: "short" });

/** One or two letters for the circle, out of the name or the part of the address before the @. */
const initials = (called: string): string => {
  const parts = called.split(/[\s.\-_+]/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
};

/** One line on the page: somebody on one agent, in already or still invited. */
interface Row {
  email: string;
  name: string;
  agent: string;
  given: Switch[];
  invited: boolean;
  state: string;
}

/**
 * Who the owner has let in to which agent, grouped by agent, with what each may
 * do there as toggles, and a card to invite somebody else. Inviting makes a
 * link the owner sends themselves: the runtime mails nobody.
 */
export function People({ agents }: { agents: AgentSummary[] }) {
  const [people, setPeople] = useState<Everybody | null>(null);
  const [trouble, setTrouble] = useState("");
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPeople(await api.people());
      setTrouble("");
    } catch (error) {
      setTrouble((error as Error).message);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function tried(what: () => Promise<Everybody>) {
    setBusy(true);
    try {
      setPeople(await what());
      setTrouble("");
    } catch (error) {
      setTrouble((error as Error).message);
    }
    setBusy(false);
  }

  const rows: Row[] = [
    ...(people?.people ?? []).flatMap((one) =>
      Object.entries(one.given).map(([agent, given]) => ({
        email: one.email,
        name: one.name,
        agent,
        given,
        invited: false,
        state: `In since ${day(one.added)}`,
      })),
    ),
    ...(people?.invitations ?? []).map((one) => ({
      email: one.email,
      name: one.name,
      agent: one.agent,
      given: one.given,
      invited: true,
      state: `Invited, the link works until ${day(one.expires)}`,
    })),
  ];
  const groups = [...new Set(rows.map((one) => one.agent))].sort();

  return (
    <>
      <div className="head">
        <h1>People</h1>
        {!inviting && agents.length > 0 && (
          <button className="go small" onClick={() => setInviting(true)}>
            Invite somebody
          </button>
        )}
      </div>
      <p className="empty">
        Let somebody use one of your agents. They see only the agents you invite them to, and on each only what you
        allow here. Nothing they are given lets them change anything.
      </p>

      {trouble && <p className="bad">{trouble}</p>}

      {inviting && <Invite agents={agents} done={() => setInviting(false)} made={refresh} />}

      {!people ? (
        !trouble && <p className="dim">Loading</p>
      ) : rows.length === 0 ? (
        !inviting && <p className="empty frame">Nobody yet. Invite somebody to let them use one agent.</p>
      ) : (
        groups.map((agent) => (
          <section key={agent}>
            <h2 className="group">{labelOf(agent)}</h2>
            <ul className="rows">
              {rows
                .filter((one) => one.agent === agent)
                .map((one) => (
                  <li key={`${one.email} ${one.invited}`}>
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
                            title={on && one.given.length === 1 ? `${each.means} The last one cannot be taken away: remove them instead.` : each.means}
                            disabled={busy || (on && one.given.length === 1)}
                            onClick={() =>
                              void tried(() =>
                                api.changePerson(
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
                        const what = one.invited
                          ? `Stop the invitation to ${one.email}? The link stops working.`
                          : `Take ${one.email} off ${labelOf(one.agent)}? They lose it at once.`;
                        if (window.confirm(what)) void tried(() => api.removePerson(one.email, one.agent));
                      }}
                    >
                      Remove
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
function Invite({ agents, done, made }: { agents: AgentSummary[]; done: () => void; made: () => unknown }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState(agents[0]?.id ?? "");
  const [given, setGiven] = useState<Switch[]>(["chat"]);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState("");
  // The link, which the runtime hands over once and never again.
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState("");

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const who = email.trim();
    if (!who || !agent || !given.length) return;
    setBusy(true);
    try {
      const { path } = await api.invite(who, name.trim(), agent, given);
      setLink({ email: who, url: window.location.origin + path });
      setCopied("");
      setTrouble("");
      await made();
    } catch (error) {
      setTrouble((error as Error).message);
    }
    setBusy(false);
  }

  if (link) {
    return (
      <section className="ready">
        <h2>The link for {link.email}</h2>
        <p className="dim">Send this link to them yourself. It works once, for a week. Chloe sends nothing.</p>
        <pre className="key">{link.url}</pre>
        <p className="dim">It is not shown again. If it is lost, remove the invitation below and make another.</p>
        <div className="buttons">
          <button
            className="go small"
            onClick={() => void copy(link.url).then((done) => setCopied(done ? "Copied." : "This browser would not copy it. Select it and copy it by hand."))}
          >
            Copy the link
          </button>
          <button
            className="small"
            onClick={() => {
              setLink(null);
              setEmail("");
              setName("");
            }}
          >
            Invite somebody else
          </button>
          <button className="plain small" onClick={done}>
            Done
          </button>
          {copied && <span className="dim">{copied}</span>}
        </div>
      </section>
    );
  }

  return (
    <section className="ready">
      <h2>Invite somebody</h2>
      <p className="dim">You get a link to send them. With it they choose a password, and sign in with their email and that password after.</p>
      {trouble && <p className="bad">{trouble}</p>}
      <form onSubmit={send}>
        <div className="fields">
          <label>
            Email
            <input value={email} type="email" autoFocus placeholder="name@example.com" onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Name, if you like
            <input value={name} placeholder="What to call them" onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Agent
            <select value={agent} onChange={(event) => setAgent(event.target.value)}>
              {agents.map((one) => (
                <option key={one.id} value={one.id}>
                  {labelOf(one.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="switches">
          <legend>What they may do</legend>
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
                <b>{each.short}</b>
                <span>{each.means}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="buttons">
          <button className="go small" type="submit" disabled={busy || !email.trim() || !agent || !given.length}>
            {busy ? "Making it" : "Make the link"}
          </button>
          <button className="plain small" type="button" onClick={done}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
