// Where the page is, as an address and back again. No React: what draws a
// link is views/components/Link.tsx.

/** Where the page is. One of these is one address in the bar. */
export type View =
  | { at: "home" }
  | { at: "agent"; agent: string }
  | { at: "file"; agent: string; path: string }
  /** A conversation is in the address once it has anything in it, so a reload comes back to it. */
  | { at: "chat"; agent: string; thread?: string }
  /** What it is told to do, and the words it reaches for when it needs them. */
  | { at: "instructions"; agent: string }
  | { at: "skills"; agent: string }
  /** What it runs on a clock, and what it can do. */
  | { at: "jobs"; agent: string }
  | { at: "tools"; agent: string }
  /** The ways in it binds, and what it can reach outside this box. */
  | { at: "channels"; agent: string }
  | { at: "connections"; agent: string }
  | { at: "log"; agent?: string; run?: string }
  /** Tokens for other systems: making them and revoking them. */
  | { at: "tokens" }
  /** Who the owner has invited to which agent, and inviting somebody. */
  | { at: "people" }
  /** The page an invitation's link opens. Shown without signing in. */
  | { at: "invitation"; code: string }
  /** Where one agent remembers things. No path is the top of it. */
  | { at: "memory"; agent: string; path?: string }
  /** Every route the runtime answers, read from GET /api. Shown without signing in. */
  | { at: "api" }
  /** How this browser shows the page, and what the account can be told to do. */
  | { at: "settings" }
  /** Signing in. "making" is the same form when this copy has no account yet. */
  | { at: "signin"; making: boolean };

/** A conversation as it is in the address: without its agent's id in front when it has it. */
const conversation = (agent: string, thread: string): string =>
  thread.startsWith(`${agent}/`) ? thread.slice(agent.length + 1) : thread;

/**
 * An agent is under /agents/ rather than at the top, so that an agent called
 * "runs" is still an agent and not a broken page. Everything of one agent's is
 * under its id: /agents/cc/log, /agents/cc/chat, and its files under files/,
 * so /agents/tempo/files/skills/analytics.md is that file, where it lives.
 * /log is every agent's log at once.
 */
export function href(view: View): string {
  switch (view.at) {
    case "home":
      return "/";
    case "agent":
      return `/agents/${view.agent}`;
    case "file":
      return `/agents/${view.agent}/files/${view.path}`;
    case "chat":
      return `/agents/${view.agent}/chat` + (view.thread ? `/${encodeURIComponent(conversation(view.agent, view.thread))}` : "");
    case "instructions":
    case "skills":
    case "jobs":
    case "tools":
    case "channels":
    case "connections":
      return `/agents/${view.agent}/${view.at}`;
    case "tokens":
      return "/tokens";
    case "people":
      return "/people";
    case "invitation":
      return `/invitation/${encodeURIComponent(view.code)}`;
    case "settings":
      return "/settings";
    case "memory":
      return `/agents/${view.agent}/memory${view.path ? `/${view.path}` : ""}`;
    // The runtime's own: a browser asking for /api gets this page, and anything else the list as JSON.
    case "api":
      return "/api";
    case "signin":
      return view.making ? "/setup" : "/login";
    case "log":
      return (view.agent ? `/agents/${view.agent}/log` : "/log") + (view.run ? `?run=${view.run}` : "");
  }
}

/** The other way round: the address in the bar, read back. */
export function read(path = window.location.pathname, search = window.location.search): View {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const run = new URLSearchParams(search).get("run") ?? undefined;
  const thread = new URLSearchParams(search).get("thread") ?? undefined;

  if (parts[0] === "login" || parts[0] === "setup") return { at: "signin", making: parts[0] === "setup" };
  if (parts[0] === "settings") return { at: "settings" };
  if (parts[0] === "agents" && parts[1]) {
    const [, agent, what, ...rest] = parts;
    if (!what) return { at: "agent", agent };
    if (what === "files" && rest.length) return { at: "file", agent, path: rest.join("/") };
    if (what === "log" && !rest.length) return { at: "log", agent, run };
    if (what === "chat" && rest.length === 1) return { at: "chat", agent, thread: rest[0].includes("/") ? rest[0] : `${agent}/${rest[0]}` };
    // Before a conversation was a part of the address it was ?thread=, and links to one are still around.
    if (what === "chat" && !rest.length) return { at: "chat", agent, thread };
    if (
      !rest.length &&
      (what === "instructions" ||
        what === "skills" ||
        what === "jobs" ||
        what === "tools" ||
        what === "channels" ||
        what === "connections")
    ) {
      return { at: what, agent };
    }
    if (what === "memory") return { at: "memory", agent, path: rest.join("/") || undefined };
    // A file used to sit straight under the agent, and links to one are still around.
    return { at: "file", agent, path: [what, ...rest].join("/") };
  }
  if (parts[0] === "api" && parts.length === 1) return { at: "api" };
  if (parts[0] === "log") return { at: "log", run };
  if (parts[0] === "tokens") return { at: "tokens" };
  if (parts[0] === "people") return { at: "people" };
  if (parts[0] === "invitation" && parts[1]) return { at: "invitation", code: parts[1] };
  // Old addresses: a chat, and a run.
  if (parts[0] === "say" && parts[1]) return { at: "chat", agent: parts[1] };
  if (parts[0] === "run" && parts[1]) return { at: "log", run: parts[1] };
  return { at: "home" };
}

export function go(view: View): void {
  // The way in keeps ?back=, which says where to go once signed in.
  const back = view.at === "signin" ? new URLSearchParams(window.location.search).get("back") : null;
  window.history.pushState(view, "", href(view) + (back ? `?back=${encodeURIComponent(back)}` : ""));
  window.dispatchEvent(new PopStateEvent("popstate"));
}
