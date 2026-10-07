// Where the page is, as an address and back again. No React: what draws a
// link is views/components/Link.tsx.

/**
 * Which workspace the page is inside, when it is in front of a cloud.
 *
 * Every address of one workspace's is under /workspaces/<name>/, and
 * everything after that prefix is the address the page has always had. Kept
 * here rather than threaded through every view, because it is a fact about
 * where the page is and not about any one view: `read()` sets it from the
 * address and `href()` puts it back.
 */
let inside: string | null = null;

/** The workspace the page is in, or null when it is in front of one runtime. */
export function workspace(): string | null {
  return inside;
}

/** Say which workspace the page is in. Null for a runtime of its own. */
export function enter(name: string | null): void {
  inside = name;
}

/** What goes in front of every workspace-level address. */
const prefix = (): string => (inside ? `/workspaces/${encodeURIComponent(inside)}` : "");

/** Where the page is. One of these is one address in the bar. */
export type View =
  | { at: "home" }
  /** Every workspace a cloud hosts. Only a cloud has this. Its front page is a chat, not this. */
  | { at: "workspaces" }
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
  /** Where one agent remembers things. No path is the top of it. */
  | { at: "memory"; agent: string; path?: string }
  /** Every route the runtime answers, read from GET /api. Shown without signing in. */
  | { at: "api" }
  /** Who a workspace's owner has let in to its agents. Only inside a workspace on a cloud. */
  | { at: "people" }
  /** The keys a workspace's runtime connects with. Only inside a workspace on a cloud. */
  | { at: "keys" }
  /** Who is signed in. Only a cloud knows a person by name. */
  | { at: "profile" }
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
  const under = prefix();
  switch (view.at) {
    case "home":
      return under || "/";
    case "workspaces":
      return "/workspaces";
    case "agent":
      return `${under}/agents/${view.agent}`;
    case "file":
      return `${under}/agents/${view.agent}/files/${view.path}`;
    case "chat":
      return `${under}/agents/${view.agent}/chat` + (view.thread ? `/${encodeURIComponent(conversation(view.agent, view.thread))}` : "");
    case "instructions":
    case "skills":
    case "jobs":
    case "tools":
    case "channels":
    case "connections":
      return `${under}/agents/${view.agent}/${view.at}`;
    case "tokens":
      return `${under}/tokens`;
    case "people":
    case "keys":
      return `${under}/${view.at}`;
    // The account is the whole server's and not one workspace's, so these two
    // sit at the top however deep in a workspace the page was.
    case "profile":
      return "/profile";
    case "settings":
      return "/settings";
    case "memory":
      return `${under}/agents/${view.agent}/memory${view.path ? `/${view.path}` : ""}`;
    // The runtime's own: a browser asking for /api gets this page, and anything else the list as JSON.
    case "api":
      return "/api";
    // The way in is the host's, never a workspace's: it is the cloud that
    // signs somebody in, whichever workspace they were heading for.
    case "signin":
      return view.making ? "/signup" : "/login";
    case "log":
      return `${under}${view.agent ? `/agents/${view.agent}/log` : "/log"}` + (view.run ? `?run=${view.run}` : "");
  }
}

/**
 * The other way round: the address in the bar, read back.
 *
 * An address under /workspaces/<name>/ says which workspace the page is
 * in, which is remembered, and the rest of it reads as it always has. So
 * /workspaces/acme/agents/cc/log is cc's log inside acme.
 */
export function read(path = window.location.pathname, search = window.location.search): View {
  let parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const run = new URLSearchParams(search).get("run") ?? undefined;
  const thread = new URLSearchParams(search).get("thread") ?? undefined;

  // Which workspace the page is in comes from the address and nowhere else,
  // so a link back to the list drops the prefix rather than carrying it.
  if (parts[0] === "workspaces" && parts[1]) {
    enter(parts[1]);
    parts = parts.slice(2);
    if (!parts.length) return { at: "home" };
  } else {
    enter(null);
    if (parts[0] === "workspaces") return { at: "workspaces" };
    // The way in, whichever kind of server it is. It is not inside anything.
    if (parts[0] === "login" || parts[0] === "signup" || parts[0] === "setup") {
      return { at: "signin", making: parts[0] !== "login" };
    }
  }
  if (inside && (parts[0] === "people" || parts[0] === "keys") && parts.length === 1) return { at: parts[0] };
  if (parts[0] === "profile") return { at: "profile" };
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
  if (parts[0] === "api" && parts.length === 1 && !inside) return { at: "api" };
  if (parts[0] === "log") return { at: "log", run };
  if (parts[0] === "tokens") return { at: "tokens" };
  if (parts[0] === "login" || parts[0] === "setup" || parts[0] === "signup") {
    return { at: "signin", making: parts[0] !== "login" };
  }
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
