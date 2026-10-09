import { type ReactNode, useCallback, useEffect, useState } from "react";

import * as Icons from "./views/components/Icons.tsx";
import { AgentChanges } from "./views/components/Changes.tsx";
import { ContextMenu, type Choice } from "./views/components/ContextMenu.tsx";
import { Link } from "./views/components/Link.tsx";
import { Dot, Rail } from "./views/components/Tree.tsx";
import { api, EVERYTHING, NeedsSignIn, servesFrom, type Serves } from "./lib/api.ts";
import { labelOf, many, shareLabels } from "./lib/format.ts";
import { allowed, landing, may, NOT_GIVEN } from "./lib/given.ts";
import { go, href, read, type View } from "./lib/route.ts";
import { lastAgent, lastFile } from "./lib/tabs.ts";
import type { AgentSummary, Entry, Given, Me, ParkedRun, RunRow } from "./lib/types.ts";
import { Api } from "./views/Api.tsx";
import { Chat } from "./views/Chat.tsx";
import { Doorway } from "./views/Doorway.tsx";
import { Open } from "./views/Files.tsx";
import { Channels } from "./views/Channels.tsx";
import { Connections } from "./views/Connections.tsx";
import { Home } from "./views/Home.tsx";
import { Instructions } from "./views/Instructions.tsx";
import { Invitation } from "./views/Invitation.tsx";
import { Jobs } from "./views/Jobs.tsx";
import { Skills } from "./views/Skills.tsx";
import { Tools } from "./views/Tools.tsx";
import { Settings } from "./views/Settings.tsx";
import { Log, LogTable } from "./views/Log.tsx";
import { Memory } from "./views/Memory.tsx";
import { People } from "./views/People.tsx";
import { Tokens } from "./views/Tokens.tsx";

/** Often enough that the overview is current, rarely enough to be quiet. */
const EVERY = 20_000;

export function App() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [parked, setParked] = useState<ParkedRun[]>([]);
  const [running, setRunning] = useState<string[]>([]);

  const [trouble, setTrouble] = useState("");
  const [view, setView] = useState<View>(() => read());
  // The folder of whichever agent the address names, fetched once for the page
  // and the rail together.
  const [files, setFiles] = useState<Entry[] | null>(null);
  // Nothing is asked for until this is known, so a server with no agents is
  // never asked about them.
  const [serves, setServes] = useState<Serves | null>(null);
  // The owner, or somebody they invited. Nothing is drawn until it is known, so
  // somebody invited never sees the owner's page first.
  const [me, setMe] = useState<Me | null>(null);

  const here = "agent" in view ? view.agent : undefined;

  // None needs a session: the way in, the list of routes, and an invitation.
  const out = view.at === "signin" || view.at === "api" || view.at === "invitation";

  useEffect(() => {
    const follow = () => setView(read());
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);

  /**
   * No session, so show the way in. Which of the two forms it is comes from the
   * server, because only it knows whether an account has been made yet.
   */
  const wayIn = useCallback(async () => {
    const { exists } = await api.account().catch(() => ({ exists: true }));
    go({ at: "signin", making: !exists });
  }, []);

  useEffect(() => {
    let stale = false;
    api.routes().then(
      (routes) => !stale && setServes(servesFrom(routes)),
      () => !stale && setServes(EVERYTHING),
    );
    return () => void (stale = true);
  }, []);

  useEffect(() => {
    if (out) return;
    let stale = false;
    api.me().then(
      (who) => !stale && setMe(who),
      (error) => {
        if (stale) return;
        if (error instanceof NeedsSignIn) return void wayIn();
        // A runtime from before anybody could be invited has nobody but its owner.
        setMe({ owner: true });
      },
    );
    return () => void (stale = true);
  }, [out, wayIn]);

  const refresh = useCallback(async () => {
    if (!serves?.agents) return;
    try {
      const [all, history, waiting, health] = await Promise.all([api.agents(), api.runs(150), api.parked(), api.health()]);
      shareLabels(all);
      setAgents(all);
      setRuns(history);
      setParked(waiting);
      setRunning(health.running);
      setTrouble("");
    } catch (error) {
      if (error instanceof NeedsSignIn) return void wayIn();
      setTrouble((error as Error).message);
    }
  }, [wayIn, serves]);

  useEffect(() => {
    if (!out) void refresh();
  }, [refresh, out]);

  // Not until the runtime has said it has agents to ask about. An agent's files
  // are the owner's alone.
  const owner = me?.owner === true;
  useEffect(() => {
    if (!here || !serves?.agents || !owner) return setFiles(null);
    let stale = false;
    setFiles(null);
    api.files(here).then((entries) => !stale && setFiles(entries), () => !stale && setFiles([]));
    return () => {
      stale = true;
    };
  }, [here, serves, owner]);

  // Only while the overview is up. A page somebody is reading or typing into
  // has nothing to gain from reloading underneath them.
  useEffect(() => {
    if (view.at !== "home") return;
    const timer = setInterval(() => void refresh(), EVERY);
    return () => clearInterval(timer);
  }, [view.at, refresh]);

  async function fire(agent: string, job: string) {
    await api.fire(agent, job);
    setTimeout(() => void refresh(), 1200);
  }

  // Somebody the owner invited: each agent they may reach, with what they were
  // given on it. Null for the owner.
  const given: Given | null = me && !me.owner ? me.given : null;
  const ids = agents.length ? agents.map((one) => one.id) : Object.keys(given ?? {});
  const mayHere = !given || allowed(given, view);
  const landAt = given && !mayHere ? landing(given, ids, here) : null;

  // Somebody invited who is somewhere they were not given goes to the first
  // place they were, in place of this one in the history.
  useEffect(() => {
    if (!landAt) return;
    window.history.replaceState(landAt, "", href(landAt));
    setView(landAt);
  }, [landAt && href(landAt)]);

  /** The agents somebody invited may reach `what` on. The owner, every one. */
  const reach = (what: (agent: string) => boolean) => agents.filter((one) => what(one.id));
  const chats = reach((agent) => !given || may(given, agent, "chat"));
  const jobs = reach((agent) => !given || allowed(given, { at: "jobs", agent }));
  const reads = !given || allowed(given, { at: "log" });

  const busy = running.length;
  // Everywhere that is inside one agent. Its sidebar and its name in the bar
  // belong on every one of them.
  const inside = Boolean(here);
  // Chat and memory carry their own two columns and put the same sidebar in
  // the first of them, so the shell is every other page of an agent's.
  // Somebody invited has no sidebar: every page on it is the owner's.
  const railed = inside && view.at !== "chat" && view.at !== "memory" && !given;

  if (view.at === "api") return <Api />;
  if (view.at === "signin") return <Doorway making={view.making} />;
  if (view.at === "invitation") return <Invitation code={view.code} />;
  if (!serves || !me) return null;

  const jobsOf = (agent: string) => (
    <Jobs
      agent={agents.find((one) => one.id === agent)}
      id={agent}
      running={running}
      fire={fire}
      cannot={given && !may(given, agent, "run") ? NOT_GIVEN : undefined}
      owner={!given}
    />
  );

  return (
    <>
      <header className="bar">
        <Link to={{ at: "home" }} className="mark">
          <span className="glyph" />
          Chloe
        </Link>
        {/* Which agent you are with, in the bar rather than in a column, so no
            page has to give up room to hold it. */}
        {agents[0] && <WhichAgent here={here} all={agents} view={view} given={given} />}
        <Menu closeOn={window.location.pathname}>
          {/* Config, Chat and Memory belong to an agent, so these go to the
              one you are with, or were last with. Config is every page of its
              own, with the sidebar that moves between them. */}
          {agents[0] && !given && (
            <>
              <Link to={lastOf("agent", agents, view)} current={railed}>
                Config
              </Link>
              <Link to={lastOf("chat", agents, view)} current={view.at === "chat"}>
                Chat
              </Link>
              <Link to={lastOf("memory", agents, view)} current={view.at === "memory"}>
                Memory
              </Link>
            </>
          )}
          {given && chats[0] && (
            <Link to={lastOf("chat", chats, view)} current={view.at === "chat"}>
              Chat
            </Link>
          )}
          {given && jobs[0] && (
            <Link to={lastOf("jobs", jobs, view)} current={view.at === "jobs"}>
              Jobs
            </Link>
          )}
          {reads && (
            <Link
              to={here && (!given || may(given, here, "read")) ? { at: "log", agent: here } : { at: "log" }}
              current={view.at === "log"}
            >
              Log
            </Link>
          )}
          {serves.tokens && !given && (
            <Link to={{ at: "tokens" }} current={view.at === "tokens"}>
              Tokens
            </Link>
          )}
          {serves.people && !given && (
            <Link to={{ at: "people" }} current={view.at === "people"}>
              People
            </Link>
          )}
        </Menu>
        {/* Only what is not already on the page below. How many agents there
            are is the page below. */}
        {busy > 0 && <span className="count num">{many(busy, "run")} now</span>}
        {trouble && <span className="bad num">{trouble}</span>}
        <You me={me} />
      </header>

      {/* A rail is for moving around inside one agent. The way in is not
          inside anything, so it gets the whole window, and so do a chat, the
          log and memory, which bring their own list down the left. */}
      {!mayHere ? (
        <main className="pane front">
          {!landAt && <p className="empty frame">Nothing here has been given to you yet. Ask whoever invited you.</p>}
        </main>
      ) : view.at === "chat" ? (
        <Chat agent={view.agent} thread={view.thread} />
      ) : view.at === "log" ? (
        <Log agent={view.agent} agents={given ? reach((agent) => may(given, agent, "read")) : agents} open={view.run} />
      ) : view.at === "memory" ? (
        <Memory agents={agents} agent={view.agent} path={view.path} />
      ) : !railed ? (
        <main className="pane front">
          {view.at === "home" && (
            <Home agents={agents} runs={runs} parked={parked} running={running} refresh={() => void refresh()} />
          )}
          {view.at === "tokens" && <Tokens />}
          {view.at === "people" && <People agents={agents} />}
          {view.at === "settings" && <Settings />}
          {view.at === "jobs" && given && jobsOf(view.agent)}
        </main>
      ) : (
      <div className="shell">
        <Rail agent={here!} view={view} files={files} />

        <main className="pane">
          {view.at === "instructions" && <Instructions agent={view.agent} />}
          {view.at === "skills" && <Skills agent={view.agent} />}
          {view.at === "jobs" && jobsOf(view.agent)}
          {view.at === "tools" && <Tools agent={view.agent} />}
          {view.at === "channels" && <Channels agent={view.agent} />}
          {view.at === "connections" && <Connections agent={view.agent} />}
          {view.at === "agent" && (
            <Agent
              agent={agents.find((one) => one.id === view.agent)}
              id={view.agent}
              runs={runs}
              parked={parked}
              running={running}
              files={files}
              fire={fire}
            />
          )}
          {view.at === "file" && <Open agent={view.agent} path={view.path} />}
        </main>
      </div>
      )}
    </>
  );
}

/** Signing out, and back to the way in: the form with an email, for somebody invited. */
function signOut(invited: boolean): void {
  void api.signOut().then(() => window.location.assign(invited ? "/login?invited" : "/login"));
}

/**
 * Where Config, Chat, Memory and Jobs in the bar go: the agent you are with, or
 * were last with, or the first one. A memory also goes back to the file you had open.
 */
function lastOf(what: "agent" | "chat" | "memory" | "jobs", agents: AgentSummary[], view: View): View {
  const was = "agent" in view ? view.agent : lastAgent();
  const agent = agents.some((one) => one.id === was) ? (was as string) : agents[0].id;
  return what === "memory" ? { at: "memory", agent, path: lastFile(agent) } : { at: what, agent };
}

/**
 * Which agent you are on, and the others. It keeps the page you are on where
 * it can: on somebody's log, the next agent's log is what you wanted. Somebody
 * invited goes to a page they were given on the next one, and has no overview.
 */
function WhichAgent({ here, all, view, given }: { here?: string; all: AgentSummary[]; view: View; given: Given | null }) {
  const kind = (agent: string): View =>
    view.at === "chat"
      ? { at: "chat", agent }
      : view.at === "memory"
        ? { at: "memory", agent, path: lastFile(agent) }
        : view.at === "log"
          ? { at: "log", agent }
          : view.at === "jobs" && given
            ? { at: "jobs", agent }
            : { at: "agent", agent };
  const sameKind = (agent: string): View =>
    !given || allowed(given, kind(agent)) ? kind(agent) : (landing(given, [agent], agent) ?? kind(agent));
  return (
    <Picker label={here ? labelOf(here) : given ? "Agents" : "All agents"} className="which">
      {[
        { head: "Agent" } as Choice,
        ...(given ? [] : [{ label: "All agents", run: () => go({ at: "home" }), current: !here } as Choice, "line" as Choice]),
        ...all.map((one) => ({
          label: labelOf(one.id),
          run: () => go(sameKind(one.id)),
          current: one.id === here,
        })),
      ]}
    </Picker>
  );
}

/**
 * The pages, in the bar. On a wide screen they are a row of links. On a phone
 * they are behind a button left of the mark and drop down over the page, with
 * a way to reload it, because a page installed on a phone has no browser
 * around it to do that. It closes once a link has gone somewhere.
 */
function Menu({ closeOn, children }: { closeOn: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [closeOn]);
  return (
    <>
      <button
        className="burger"
        aria-label={open ? "Close the menu" : "Open the menu"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <Icons.Close /> : <Icons.Menu />}
      </button>
      <nav className={open ? "menu open" : "menu"}>
        {children}
        <button className="reload" onClick={() => window.location.reload()}>
          <Icons.Reload />
          Reload
        </button>
      </nav>
      {open && <div className="shade" onClick={() => setOpen(false)} />}
    </>
  );
}

/** A word in the bar with a menu under it. */
function Picker({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  /** The menu, passed as the choices rather than as elements. */
  children: Choice[];
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  return (
    <>
      <button
        className={className ? `where ${className}` : "where"}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: box.left, y: box.bottom + 6 });
        }}
      >
        {label}
        <Icons.Down />
      </button>
      {at && <ContextMenu at={at} close={close} choices={children} />}
    </>
  );
}

/** One agent on its own: what it is, what it runs, and what it has been doing. */
function Agent({
  agent,
  id,
  runs,
  parked,
  running,
  files,
  fire,
}: {
  agent?: AgentSummary;
  id: string;
  runs: RunRow[];
  parked: ParkedRun[];
  running: string[];
  files: Entry[] | null;
  fire: (agent: string, job: string) => Promise<void>;
}) {
  if (!agent) return <p className="dim">Loading</p>;
  const mine = runs.filter((run) => run.agent === id);
  const held = flatten(files ?? []);

  return (
    <>
      <div className="head">
        <h1>{labelOf(agent.id)}</h1>
        <Link to={{ at: "chat", agent: id }} className="button talk">
          <Icons.Chat />
          Chat with {labelOf(agent.id)}
        </Link>
      </div>
      <p>{agent.description}</p>

      <dl className="facts">
        <dt>model</dt>
        <dd>{agent.model}</dd>
        <dt>skills</dt>
        <dd>
          <Names names={agent.skills} agent={id} held={held} folder="skills" ending=".md" />
        </dd>
        <dt>tools</dt>
        <dd>
          <Names names={agent.tools} agent={id} held={held} folder="tools" ending=".ts" />
        </dd>
      </dl>

      <div className="head spread">
        <h2>What it runs</h2>
        <Link to={{ at: "jobs", agent: id }}>All of {labelOf(id)}&rsquo;s jobs</Link>
      </div>
      {agent.jobs.length === 0 && (
        <p className="empty">Nothing on a clock. It runs when you or a message ask it to.</p>
      )}
      <table className="tight">
        <tbody>
          {agent.jobs.map((job) => {
            const now = running.includes(`${id}/${job.id}`);
            const file = held.find((path) => path.startsWith(`jobs/${job.id}.`));
            return (
              <tr key={job.id}>
                <td className={job.when ? "timing" : "cron"} title={job.cron}>
                  {job.channels ? `each message on ${job.channels.join(" and ")}` : (job.when ?? job.cron ?? "when started")}
                </td>
                <td title={job.description}>
                  {file ? <Link to={{ at: "file", agent: id, path: file }}>{job.id}</Link> : job.id}
                </td>
                <td className="dim num aside">{job.timezone}</td>
                <td className="dim aside">{job.code ? "code" : job.model}</td>
                <td className="right">
                  {!job.channels && (
                    <button className="small" onClick={() => fire(id, job.id)} disabled={now}>
                      {now ? "Running" : "Run now"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <AgentChanges agent={id} />

      <div className="head spread">
        <h2>Log</h2>
        <Link to={{ at: "log", agent: id }}>{labelOf(id)}&rsquo;s full log</Link>
      </div>
      <LogTable rows={mine.slice(0, 12)} agent={id} />
    </>
  );
}

/**
 * Skill and tool names, each one a link when that agent has the file. A tool
 * every agent gets is written once in the runtime and is not in this folder, so
 * it is a name and not a link.
 */
function Names({
  names,
  agent,
  held,
  folder,
  ending,
}: {
  names: string[];
  agent: string;
  held: string[];
  folder: string;
  ending: string;
}) {
  if (names.length === 0) return <>none</>;
  return (
    <>
      {names.map((name, at) => {
        const path = `${folder}/${name}${ending}`;
        return (
          <span key={name}>
            {at > 0 && ", "}
            {held.includes(path) ? (
              <Link to={{ at: "file", agent, path }}>{name}</Link>
            ) : (
              <span className="dim" title="Written once in the runtime, not in this agent's folder">
                {name}
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

/** Every file in the tree, by the path it has inside the agent's folder. */
function flatten(entries: Entry[]): string[] {
  return entries.flatMap((entry) => (entry.dir ? flatten(entry.children ?? []) : [entry.path]));
}

/**
 * The account, from the right of the bar. The owner is the one account with a
 * password and no name, so it says Account. Somebody invited sees their name,
 * and has nothing here but signing out.
 */
function You({ me }: { me: Me }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const choices: Choice[] = me.owner
    ? [
        { label: "Account settings", run: () => go({ at: "settings" }) },
        { label: "Sign out", run: () => signOut(false) },
      ]
    : [{ head: me.email }, { label: "Sign out", run: () => signOut(true) }];
  return (
    <>
      <button
        className="you"
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-label="Account"
        // Kept from the menu's own close-on-mousedown, so a second click shuts it.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: box.right, y: box.bottom + 8 });
        }}
      >
        <span className="who">{me.owner ? "Account" : me.name || me.email}</span>
        <Icons.Down />
      </button>
      {at && <ContextMenu at={at} from="right" close={close} choices={choices} />}
    </>
  );
}
