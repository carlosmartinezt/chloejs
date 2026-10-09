import { type ReactNode, useCallback, useEffect, useState } from "react";

import * as Icons from "./views/components/Icons.tsx";
import { AgentChanges } from "./views/components/Changes.tsx";
import { ContextMenu, type Choice } from "./views/components/ContextMenu.tsx";
import { Link } from "./views/components/Link.tsx";
import { Dot, Rail } from "./views/components/Tree.tsx";
import { api, cloud, EVERYTHING, NeedsSignIn, serverAt, servesFrom, type Serves } from "./lib/api.ts";
import { initials, labelOf, many, shareLabels, when } from "./lib/format.ts";
import { homeAt, homeOf } from "./lib/home.ts";
import { go, workspace, read, type View } from "./lib/route.ts";
import { lastAgent, lastFile } from "./lib/tabs.ts";
import type { AgentSummary, Entry, Given, Me, Workspace, ParkedRun, RecentWork, RunRow, Signup } from "./lib/types.ts";
import { Api } from "./views/Api.tsx";
import { Chat } from "./views/Chat.tsx";
import { Doorway } from "./views/Doorway.tsx";
import { Open } from "./views/Files.tsx";
import { Offline } from "./views/components/Offline.tsx";
import { Channels } from "./views/Channels.tsx";
import { Connections } from "./views/Connections.tsx";
import { Home } from "./views/Home.tsx";
import { Instructions } from "./views/Instructions.tsx";
import { Jobs } from "./views/Jobs.tsx";
import { Skills } from "./views/Skills.tsx";
import { Tools } from "./views/Tools.tsx";
import { Profile } from "./views/Profile.tsx";
import { Settings } from "./views/Settings.tsx";
import { Setup } from "./views/Setup.tsx";
import { Workspaces } from "./views/Workspaces.tsx";
import { Keys } from "./views/Keys.tsx";
import { People } from "./views/People.tsx";
import { Dots, workspaceChoices } from "./views/components/Manage.tsx";
import { Log, LogTable } from "./views/Log.tsx";
import { Memory } from "./views/Memory.tsx";
import { Tokens } from "./views/Tokens.tsx";

/** Often enough that the overview is current, rarely enough to be quiet. */
const EVERY = 20_000;

export function App() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [parked, setParked] = useState<ParkedRun[]>([]);
  const [running, setRunning] = useState<string[]>([]);

  const [recentWork, setRecentWork] = useState<Record<string, RecentWork[]>>({});
  const [trouble, setTrouble] = useState("");
  const [view, setView] = useState<View>(() => read());
  // The folder of whichever agent the address names, fetched once for the page
  // and the rail together.
  const [files, setFiles] = useState<Entry[] | null>(null);
  // Nothing is asked for until this is known, so a server with no agents is
  // never asked about them.
  const [serves, setServes] = useState<Serves | null>(null);
  // On a cloud: who may make an account, and the workspace the address names.
  const [signup, setSignup] = useState<Signup>("closed");
  const [where, setWhere] = useState<Workspace | null>(null);
  // Every workspace this account can reach, for the switcher in the bar.
  const [everywhere, setEverywhere] = useState<Workspace[]>([]);
  // On a cloud: the account this browser is signed in as, for the bar.
  const [me, setMe] = useState<Me | null>(null);

  const here = "agent" in view ? view.agent : undefined;
  const at = workspace();

  // Neither needs a session: the way in, and the list of routes.
  const out = view.at === "signin" || view.at === "api";

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
    // What the last address was in front of is not true of this one. Showing
    // it until this one answers is a page that flashes up and goes.
    setServes(null);
    void (async () => {
      let host: Serves;
      try {
        host = servesFrom(await api.hostRoutes());
      } catch {
        return void (!stale && setServes(EVERYTHING));
      }
      if (stale) return;
      if (!host.cloud) return void setServes(host);

      // A cloud. Inside a workspace the page talks to that runtime through
      // it, so it asks that runtime what it can do, exactly as it would ask one
      // directly. Outside, there is only the list.
      void cloud.account().then((said) => !stale && setSignup(said.signup ?? "closed"), () => {});
      void cloud.me().then((who) => !stale && setMe(who), () => {});
      void cloud.workspaces().then((all) => !stale && setEverywhere(all), () => {});
      if (!at) return void setServes({ ...host, agents: false });
      serverAt(`/workspaces/${encodeURIComponent(at)}/api`);
      try {
        const runtime = servesFrom(await api.routes());
        if (!stale) setServes({ ...runtime, cloud: true, tokens: false });
      } catch (error) {
        if (stale) return;
        if (error instanceof NeedsSignIn) return void wayIn();
        // Offline, or a runtime that will not say: show what the cloud has.
        setServes({ agents: true, tokens: false, cloud: true });
      }
    })();
    return () => void (stale = true);
  }, [at, wayIn]);

  /** What the cloud knows about the workspace the page is in, and whether it is connected. */
  const lookAtWorkspace = useCallback(async () => {
    if (!at) return setWhere(null);
    try {
      setWhere(await cloud.workspace(at));
    } catch (error) {
      if (error instanceof NeedsSignIn) return void wayIn();
    }
  }, [at, wayIn]);

  useEffect(() => {
    if (!serves?.cloud) return;
    void lookAtWorkspace();
  }, [serves, lookAtWorkspace]);

  // A cloud's front page is a chat: the account's home agent, or the first one
  // there is. With nobody to chat with yet, it is the list of workspaces.
  const front = Boolean(serves?.cloud && !at && view.at === "home");
  useEffect(() => {
    if (!front) return;
    let stale = false;
    Promise.all([cloud.me(), cloud.workspaces()]).then(
      ([who, all]) => {
        if (stale) return;
        const home = homeOf(who, all);
        window.history.replaceState(null, "", home ? homeAt(home) : "/workspaces");
        setView(read());
      },
      (error) => !stale && error instanceof NeedsSignIn && void wayIn(),
    );
    return () => void (stale = true);
  }, [front, wayIn]);

  const refresh = useCallback(async () => {
    if (!serves?.agents) return;
    try {
      const [all, history, waiting, health, recent] = await Promise.all([
        api.agents(),
        api.runs(150),
        api.parked(),
        api.health(),
        api.recentWork(),
      ]);
      shareLabels(all);
      setAgents(all);
      setRuns(history);
      setParked(waiting);
      setRunning(health.running);
      setRecentWork(recent);
      setTrouble("");
    } catch (error) {
      if (error instanceof NeedsSignIn) return void wayIn();
      setTrouble((error as Error).message);
    }
  }, [wayIn, serves]);

  useEffect(() => {
    if (!out) void refresh();
  }, [refresh, out]);

  // Not until the page knows what it is in front of: through a cloud, where the
  // API is is only settled once the host has said so, and a call before that
  // would go to the cloud's own address instead of the workspace's.
  useEffect(() => {
    if (!here || !serves?.agents) return setFiles(null);
    let stale = false;
    setFiles(null);
    api.files(here).then((entries) => !stale && setFiles(entries), () => !stale && setFiles([]));
    return () => {
      stale = true;
    };
  }, [here, serves]);

  // Only while the overview is up. A page somebody is reading or typing into
  // has nothing to gain from reloading underneath them.
  useEffect(() => {
    if (view.at !== "home") return;
    const timer = setInterval(() => {
      void refresh();
      if (serves?.cloud) void lookAtWorkspace();
    }, EVERY);
    return () => clearInterval(timer);
  }, [view.at, refresh, serves, lookAtWorkspace]);

  async function fire(agent: string, job: string) {
    await api.fire(agent, job);
    setTimeout(() => void refresh(), 1200);
  }

  // A guest of this workspace: each agent they may reach, with what they were
  // given on it. The runtime refuses the rest anyway; this keeps the page from
  // offering it.
  const given = where?.guest;
  const may = useCallback(
    (agent: string, what: Given): boolean => !given || (given[agent] ?? []).includes(what),
    [given],
  );
  const anywhere = (what: Given): boolean => !given || Object.values(given).some((list) => list.includes(what));
  const cannot = (agent: string): string | undefined =>
    may(agent, "run") ? undefined : "You have not been given this. The workspace's owner can allow it.";

  // A guest who lands somewhere they were not given goes to the first place
  // they were: a chat, the overview, or a memory.
  useEffect(() => {
    if (!given || !agents.length) return;
    const allowed = (one: View): boolean => {
      const agent = "agent" in one ? one.agent : undefined;
      switch (one.at) {
        case "chat":
          return may(one.agent, "chat");
        case "memory":
          return may(one.agent, "memory");
        case "home":
          return anywhere("read") || anywhere("run");
        case "agent":
        case "jobs":
          return may(one.agent, "read") || may(one.agent, "run");
        case "log":
          return agent ? may(agent, "read") : anywhere("read");
        case "profile":
        case "settings":
        case "signin":
        case "workspaces":
          return true;
        default:
          return Boolean(agent) && may(agent!, "read");
      }
    };
    if (allowed(view)) return;
    const ids = agents.map((one) => one.id);
    const start: View[] = [
      ...ids.filter((one) => may(one, "chat")).map((agent) => ({ at: "chat", agent }) as View),
      { at: "home" },
      ...ids.filter((one) => may(one, "memory")).map((agent) => ({ at: "memory", agent }) as View),
    ];
    const first = start.find(allowed);
    if (first) go(first);
  }, [given, agents, view, may]);

  const busy = running.length;
  // Everywhere that is inside one agent. Its sidebar and its name in the bar
  // belong on every one of them.
  const inside = Boolean(here);
  // Chat and memory carry their own two columns and put the same sidebar in
  // the first of them, so the shell is every other page of an agent's.
  const railed = inside && view.at !== "chat" && view.at !== "memory";

  if (view.at === "api") return <Api />;
  if (view.at === "signin") return <Doorway making={view.making} onCloud={Boolean(serves?.cloud)} signup={signup} />;
  if (!serves) return null;
  // A cloud, and no workspace named: the list is the whole page.
  // Nothing until the chat it is about to open, so the page is drawn once.
  if (front) return null;
  if (serves.cloud && !at) {
    return (
      <>
        <CloudBar me={me} />
        <main className="pane front">
          {view.at === "profile" ? (
            <Profile onCloud me={me} said={setMe} />
          ) : view.at === "settings" ? (
            <Settings email={me?.email} signOut={signOutOf(true)} me={me} said={setMe} />
          ) : (
            <Workspaces />
          )}
        </main>
      </>
    );
  }
  // No agents inside a workspace is a workspace whose runtime has never said anything.
  if (!serves.agents && serves.cloud && at) {
    return <Waiting name={at} where={where} me={me} said={setMe} view={view} changed={lookAtWorkspace} />;
  }
  const offline = Boolean(serves.cloud && where && !where.online);

  return (
    <>
      <header className="bar">
        {serves.cloud ? (
          <a href="/" className="mark">
            <span className="glyph" />
            Chloe
          </a>
        ) : (
          <Link to={{ at: "home" }} className="mark">
            <span className="glyph" />
            Chloe
          </Link>
        )}
        {/* Where you are, said as two things you can change: which workspace,
            and which agent inside it. Both are in the bar rather than in a
            column, so no page has to give up room to hold them. */}
        {where && <WhichWorkspace here={where} all={everywhere} />}
        {agents[0] && <WhichAgent here={here} all={agents} view={view} />}
        <Menu closeOn={window.location.pathname}>
          {/* Config, Chat and Memory belong to an agent, so these go to the
              one you are with, or were last with. Config is every page of its
              own, with the sidebar that moves between them. */}
          {agents.some((one) => may(one.id, "read")) && (
            <Link
              to={lastOf("agent", agents.filter((one) => may(one.id, "read")), view)}
              current={railed}
            >
              Config
            </Link>
          )}
          {agents.some((one) => may(one.id, "chat")) && (
            <Link to={lastOf("chat", agents.filter((one) => may(one.id, "chat")), view)} current={view.at === "chat"}>
              Chat
            </Link>
          )}
          {agents.some((one) => may(one.id, "memory")) && (
            <Link to={lastOf("memory", agents.filter((one) => may(one.id, "memory")), view)} current={view.at === "memory"}>
              Memory
            </Link>
          )}
          {anywhere("read") && (
            <Link to={here && may(here, "read") ? { at: "log", agent: here } : { at: "log" }} current={view.at === "log"}>
              Log
            </Link>
          )}
          {/* A token is the runtime's own and is made on the box it runs on, so
              it is not offered through a cloud. */}
          {serves.tokens && !serves.cloud && (
            <Link to={{ at: "tokens" }} current={view.at === "tokens"}>
              Tokens
            </Link>
          )}
        </Menu>
        {/* Only what is not already on the page below. How many agents there
            are is the page below. */}
        {busy > 0 && <span className="count num">{many(busy, "run")} now</span>}
        {trouble && <span className="bad num">{trouble}</span>}
        <You me={me} onCloud={Boolean(serves.cloud)} signOut={signOutOf(Boolean(serves.cloud))} />
      </header>

      {/* A rail is for moving around inside one agent. The way in is not
          inside anything, so it gets the whole window, and so do a chat, the
          log and memory, which bring their own list down the left. A workspace
          whose runtime is not connected keeps its synced pages, with the
          state said at the top of the page. */}
      {view.at === "chat" ? (
        <Chat agent={view.agent} thread={view.thread} offline={offline} />
      ) : view.at === "log" ? (
        <Log agent={view.agent} agents={agents} open={view.run} notice={offline && <Offline name={at} where={where} />} />
      ) : view.at === "memory" ? (
        <Memory agents={agents} agent={view.agent} path={view.path} offline={offline} where={where} />
      ) : !railed ? (
        <main className="pane front">
          {offline && <Offline name={at} where={where} />}
          {view.at === "home" && (
            <Home
              cloud={Boolean(serves.cloud)}
              machine={where?.machine}
              agents={agents}
              runs={runs}
              parked={parked}
              running={running}
              offline={offline}
              refresh={() => void refresh()}
              menu={where && !where.guest ? <Dots label={where.label} choices={() => choicesFor(where, lookAtWorkspace)} /> : undefined}
            />
          )}
          {view.at === "people" && where && !where.guest && <People workspace={where} />}
          {view.at === "keys" && where && !where.guest && <Keys workspace={where} changed={lookAtWorkspace} />}
          {view.at === "tokens" && <Tokens />}
          {view.at === "profile" && <Profile onCloud={Boolean(serves.cloud)} me={me} said={setMe} />}
          {view.at === "settings" && (
            <Settings
              email={me?.email}
              signOut={signOutOf(Boolean(serves.cloud))}
              me={serves.cloud ? me : undefined}
              said={setMe}
            />
          )}
        </main>
      ) : (
      <div className="shell">
        <Rail agent={here!} view={view} files={files} />

        <main className="pane">
          {offline && <Offline name={at} where={where} />}
          {view.at === "instructions" && <Instructions agent={view.agent} />}
          {view.at === "skills" && <Skills agent={view.agent} />}
          {view.at === "jobs" && (
            <Jobs
              agent={agents.find((one) => one.id === view.agent)}
              id={view.agent}
              running={running}
              offline={offline}
              cannot={cannot(view.agent)}
              fire={fire}
            />
          )}
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
              offline={offline}
              cannot={cannot(view.agent)}
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

/** The bar outside every workspace: the mark, and the account. */
function CloudBar({ me }: { me: Me | null }) {
  return (
    <header className="bar">
      <a href="/" className="mark">
        <span className="glyph" />
        Chloe
      </a>
      <You me={me} onCloud signOut={signOutOf(true)} />
    </header>
  );
}

/** Signing out, of a cloud or of one runtime, and back to the way in. */
function signOutOf(onCloud: boolean): () => void {
  return () => void (onCloud ? cloud.signOut() : api.signOut()).then(() => window.location.assign("/login"));
}

/**
 * A workspace in a cloud that has nothing of its own to show: either no
 * runtime has ever connected with its key, or one did and has been away long
 * enough that the cloud kept nothing about it. Both are the same question,
 * which is how to get one up, so the answer is the steps.
 */
function Waiting({
  name,
  where,
  me,
  said,
  view,
  changed,
}: {
  name: string;
  where: Workspace | null;
  me: Me | null;
  said: (me: Me) => void;
  view: View;
  /** Read the workspace again, after a key or its name changed. */
  changed: () => unknown;
}) {
  const [steps, setSteps] = useState(false);
  const label = where?.label ?? name;
  const been = Boolean(where?.lastSeen);
  return (
    <>
      <header className="bar">
        <a href="/" className="mark">
          <span className="glyph" />
          Chloe
        </a>
        <Link to={{ at: "workspaces" }} className="where">
          <Icons.Stack />
          {label}
        </Link>
        <You me={me} onCloud signOut={signOutOf(true)} />
      </header>
      <main className="pane front">
        {view.at === "profile" ? (
          <Profile onCloud me={me} said={said} />
        ) : view.at === "settings" ? (
          <Settings email={me?.email} signOut={signOutOf(true)} me={me} said={said} />
        ) : view.at === "keys" && where && !where.guest ? (
          <Keys workspace={where} changed={changed} />
        ) : view.at === "people" && where && !where.guest ? (
          <People workspace={where} />
        ) : (
          <section className="ready">
            <header>
              <div>
                <h2>{been ? `${label} is not connected` : `${label} is waiting for a runtime`}</h2>
                <p className="dim">
                  {been
                    ? `Last seen ${when(where!.lastSeen!)}. Start it again on the machine it lives on and this page fills in by itself.`
                    : "Nothing has shown up with this workspace\u2019s key yet. Here is the whole of getting one up, from an empty folder."}
                </p>
              </div>
              {where && !where.guest && <Dots label={label} choices={() => choicesFor(where, changed)} />}
            </header>
            {/* Away and back is one command. Never having got it up is the five
                steps, which are a lot to put in front of somebody who only
                needs the one, so they are behind a press. */}
            {been ? (
              <>
                <pre className="lone">
                  <code>npx chloe</code>
                </pre>
                {steps ? (
                  <Setup />
                ) : (
                  <button className="small" onClick={() => setSteps(true)}>
                    Never got it running? Show the steps
                  </button>
                )}
              </>
            ) : (
              <Setup />
            )}
          </section>
        )}
      </main>
    </>
  );
}

/**
 * Where Config, Chat and Memory in the bar go: the agent you are with, or were last
 * with, or the first one. A memory also goes back to the file you had open.
 */
function lastOf(what: "agent" | "chat" | "memory", agents: AgentSummary[], view: View): View {
  const was = "agent" in view ? view.agent : lastAgent();
  const agent = agents.some((one) => one.id === was) ? (was as string) : agents[0].id;
  return what === "memory" ? { at: "memory", agent, path: lastFile(agent) } : { at: what, agent };
}

/**
 * The workspace this page is inside, and the others. Going to one is a fresh
 * load rather than a step in the history: another workspace is another runtime
 * with its own agents, its own files and its own everything, and nothing the
 * page is holding is true of it.
 */
/**
 * A workspace's menu, as its owner gets it on its own pages. A change reads the
 * workspace again; a failed one says why in a box, since there is no line on
 * the page for it; a deleted one goes back to the list.
 */
function choicesFor(one: Workspace, changed: () => unknown): Choice[] {
  return workspaceChoices(one, {
    tried: async (what) => {
      try {
        await what();
      } catch (error) {
        window.alert((error as Error).message);
      }
      await changed();
    },
    gone: () => window.location.assign("/workspaces"),
  });
}

function WhichWorkspace({ here, all }: { here: Workspace; all: Workspace[] }) {
  return (
    <Picker
      label={here.label}
      icon={<Icons.Stack />}
      warn={!here.online}
      warnTitle={
        !here.online
          ? here.lastSeen
            ? `Offline since ${when(here.lastSeen)}. Showing what was synced.`
            : "Never connected."
          : undefined
      }
    >
      {[
        { head: "Workspace" } as Choice,
        { label: "All workspaces", run: () => window.location.assign("/workspaces") },
        "line" as Choice,
        ...all.map((one) => ({
          label: one.label,
          run: () => window.location.assign(`/workspaces/${encodeURIComponent(one.name)}`),
          current: one.name === here.name,
          red: !one.online,
          title: !one.online
            ? one.lastSeen
              ? `Offline since ${when(one.lastSeen)}. Showing what was synced.`
              : "Never connected."
            : undefined,
        })),
        // Its owner reaches its people and keys from anywhere inside it.
        ...(here.guest
          ? []
          : (["line", { label: "People", run: () => go({ at: "people" }) }, { label: "Keys", run: () => go({ at: "keys" }) }] as Choice[])),
      ]}
    </Picker>
  );
}

/**
 * Which agent you are on, and the others. It keeps the page you are on where
 * it can: on somebody's log, the next agent's log is what you wanted.
 */
function WhichAgent({ here, all, view }: { here?: string; all: AgentSummary[]; view: View }) {
  const sameKind = (agent: string): View =>
    view.at === "chat"
      ? { at: "chat", agent }
      : view.at === "memory"
        ? { at: "memory", agent, path: lastFile(agent) }
        : view.at === "log"
          ? { at: "log", agent }
          : { at: "agent", agent };
  return (
    <Picker label={here ? labelOf(here) : "All agents"} className="which">
      {[
        { head: "Agent" } as Choice,
        { label: "All agents", run: () => go({ at: "home" }), current: !here },
        "line" as Choice,
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

/** A word in the bar with a menu under it. Both switchers are one of these. */
function Picker({
  label,
  icon,
  className,
  warn,
  warnTitle,
  children,
}: {
  label: string;
  icon?: ReactNode;
  className?: string;
  /** A light-red dot before the label, for a workspace that is not connected. */
  warn?: boolean;
  /** What the dot says when hovered. */
  warnTitle?: string;
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
        {icon}
        {warn && <span className="dot bad" aria-hidden="true" title={warnTitle} />}
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
  offline,
  cannot,
  fire,
}: {
  agent?: AgentSummary;
  id: string;
  runs: RunRow[];
  parked: ParkedRun[];
  running: string[];
  files: Entry[] | null;
  /** Reached through a cloud, and its connection is not open: nothing can be started. */
  offline: boolean;
  /** Why this account may not start a job here, when it may not: a guest who was not given that. */
  cannot?: string;
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
                    <button
                      className="small"
                      onClick={() => fire(id, job.id)}
                      disabled={now || offline || Boolean(cannot)}
                      title={offline ? "This runtime is offline." : cannot}
                    >
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
 * The account, from the right of the bar: who is signed in, said short, and
 * what there is to do about it. A runtime of its own has one password and
 * nobody to tell apart, so it has no address to show and no profile to offer.
 */
function You({ me, onCloud, signOut }: { me: Me | null; onCloud: boolean; signOut: () => void }) {
  // The name if there is one, and the address if there is not. Never the front
  // of the address on its own: that is not anybody's name and reads as if the
  // page had guessed.
  const called = me?.name || me?.email || "";
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const choices: Choice[] = [
    // One head, then one line. Who you are, then what there is to do about it.
    ...(me ? ([{ head: me.name || me.email, under: me.name ? me.email : undefined }, "line"] as Choice[]) : []),
    ...(onCloud ? ([{ label: "My profile", run: () => go({ at: "profile" }) }] as Choice[]) : []),
    { label: "Account settings", run: () => go({ at: "settings" }) },
    { label: "Sign out", run: signOut },
  ];
  return (
    <>
      {onCloud && me && <Notifications me={me} />}
      <button
        className="you"
        title={me?.email}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-label={me ? `Account, signed in as ${me.email}` : "Account"}
        // Kept from the menu's own close-on-mousedown, so a second click shuts it.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: box.right, y: box.bottom + 8 });
        }}
      >
        {me && (
          <span className="initials" aria-hidden="true">
            {initials(me.name || me.email.split("@")[0])}
          </span>
        )}
        <span className="who">{called || "Account"}</span>
        <Icons.Down />
      </button>
      {at && <ContextMenu at={at} from="right" close={close} choices={choices} />}
    </>
  );
}

/**
 * The bell beside the account. What is under it comes from the cloud with the
 * account, so it changes whenever the account does, and a press on one goes
 * where it says.
 */
function Notifications({ me }: { me: Me }) {
  const all = me.notifications ?? [];
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const choices: Choice[] = [
    { head: "Notifications" },
    "line",
    ...(all.length
      ? all.flatMap((one, index) => [
          ...(index ? (["line"] as Choice[]) : []),
          { title: one.title, text: one.text, button: one.button, run: () => go(read(one.to, "")) },
        ])
      : [{ label: "Nothing new", run: () => {}, disabled: true }]),
  ];
  return (
    <>
      <button
        className="bell"
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-label={all.length ? `Notifications, ${all.length} new` : "Notifications"}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: box.right, y: box.bottom + 8 });
        }}
      >
        <Icons.Bell />
        {all.length > 0 && <span className="badge">{all.length}</span>}
      </button>
      {at && <ContextMenu at={at} from="right" close={close} choices={choices} />}
    </>
  );
}

