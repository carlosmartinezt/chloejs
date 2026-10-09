// Every call the page makes. One fetch helper, and one line per route: the
// page never builds a URL anywhere else.
import type {
  Account,
  AgentSummary,
  AgentTool,
  Change,
  Changes,
  Entry,
  Git,
  Given,
  Invitation,
  People,
  Workspace,
  Home,
  Me,
  MemoryFile,
  Opened,
  ParkedRun,
  Place,
  RecentWork,
  Relayed,
  Run,
  RunRow,
  Said,
  Skill,
  Thread,
  Way,
  Token,
  Picture,
  Visitor,
} from "./types.ts";

/**
 * Where the runtime answers. "/api" on the host the page came from is the usual
 * arrangement and needs nothing configured: a proxy serves the page and sends
 * /api on. A page served from somewhere else says where in index.html, and
 * main.tsx hands it over before anything is asked for.
 *
 * In front of a cloud this is one workspace's own base,
 * "/workspaces/<name>/api", which is why every call below works unchanged
 * either way: the cloud relays that base to the runtime it belongs to.
 */
let at = "/api";

/** Point the page at a runtime. Given nothing, says where it is pointed now. */
export function serverAt(address?: string): string {
  if (address) at = address.replace(/\/+$/, "");
  return at;
}

/**
 * Where the cloud's own routes are: always "/api" on this host, whichever
 * workspace the page is inside. Its own, because `at` moves.
 */
const CLOUD = "/api";

/**
 * Where a memory file is served for the frame it is shown in: the runtime hands
 * out `/memory/<pass>` and it hangs off the same place its API does. Locally
 * that is the root, and through a cloud it is that workspace's.
 */
export function frameAt(handed: string): string {
  return frameUnder(at, handed);
}

/** The same, said as one calculation, so it can be checked without moving where the page is pointed. */
export function frameUnder(base: string, handed: string): string {
  return base.replace(/\/api$/, "") + handed;
}

/** Signing in sets the cookie a browser uses, and hands back the same value for anything that is not one. */
interface Session {
  ok: true;
  token: string;
}

/**
 * Thrown when the server says there is no session. The page shows the way in
 * rather than the words: a 401 is an address to go to, not an error to read.
 */
export class NeedsSignIn extends Error {
  constructor() {
    super("Sign in first.");
  }
}

/**
 * What to say when a call comes back with nothing. A cloud shows runtimes
 * other people run, and one of them can be older than this page, so a route
 * this page asks for may not exist there. That is worth saying plainly rather
 * than showing somebody the number 404.
 */
export const missing = (error: Error, what: string): string =>
  /\b404\b|not found|not here/i.test(error.message)
    ? `This runtime does not answer for ${what}. It is running a chloe from before this page asked for it.`
    : error.message;

/** Where an agent's memory is answered. */
const memoryOf = (agent: string) => `/agents/${agent}/memory`;

/** The calls the login itself makes: a 401 from one of these is a wrong password. */
const GETTING_IN = ["/account", "/login", "/link"];

async function call<T>(path: string, body?: unknown, base = ""): Promise<T> {
  const response = await fetch(`${base || at}${path}`, {
    // Named rather than left to the default, because a page and a runtime on
    // two hosts of one site still have to carry the session between them.
    credentials: "include",
    ...(body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) {
    const answer = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 401 && !GETTING_IN.includes(path)) throw new NeedsSignIn();
    throw new Error(answer.error ?? `${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  /** Every route the server answers, with what each does and who may call it. Answered without a session. */
  routes: () => call<RouteDoc[]>(""),
  /** The same, of the host the page came from, which is how it learns it is in front of a cloud. */
  hostRoutes: () => call<{ method: string; path: string }[]>("", undefined, CLOUD),
  /** Whether this copy has a password yet, so the page knows which form to show. Answered without a session. */
  account: () => call<Account>("/account"),
  /** A runtime has one password and no username: with one account there is nobody to tell apart. */
  signIn: (password: string) => call<Session>("/login", { password }),
  /** The code from a link the runtime printed, swapped for a session. Each works once. */
  link: (code: string) => call<Session>("/link", { code }),
  /** The first password, from a browser already signed in. */
  setup: (password: string) => call<{ ok: true }>("/setup", { password }),
  signOut: () => call<{ ok: true }>("/logout", {}),
  agents: () => call<AgentSummary[]>("/agents"),
  agent: (id: string) => call<AgentSummary>(`/agents/${id}`),
  health: () => call<{ agents: string[]; running: string[] }>("/health"),
  runs: (limit = 60, agent?: string) =>
    call<RunRow[]>(`/runs?limit=${limit}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`),
  log: (agent: string, limit = 60) => call<RunRow[]>(`/agents/${agent}/log?limit=${limit}`),
  run: (id: string) => call<Run>(`/runs/${id}`),
  recentWork: () => call<Record<string, RecentWork[]>>("/recent-work"),
  parked: () => call<ParkedRun[]>("/parked"),
  archive: (id: string, archived: boolean) => call<{ id: string; archived: string | null }>(`/runs/${id}/archive`, { archived }),
  answer: (id: string, text: string) => call<unknown>(`/runs/${id}/answer`, { text }),
  /** Pick up a job's prompt the service stopped in the middle of, in the same run. */
  carryOn: (id: string) => call<{ carrying: string }>(`/runs/${id}/carry-on`, {}),
  fire: (agent: string, job: string) => call<unknown>(`/agents/${agent}/job/${job}`, {}),
  files: (agent: string) => call<Entry[]>(`/agents/${agent}/files`),
  /** `path` is the file the words are in, when they are in one and not written into the agent's definition. */
  instructions: (agent: string) => call<{ text: string; path?: string }>(`/agents/${agent}/instructions`),
  agentSkills: (agent: string) => call<Skill[]>(`/agents/${agent}/skills`),
  agentTools: (agent: string) => call<AgentTool[]>(`/agents/${agent}/tools`),
  channels: (agent: string) => call<Way[]>(`/agents/${agent}/channels`),
  connections: (agent: string) => call<Way[]>(`/agents/${agent}/connections`),
  /** Start a connection's sign-in: what to tell the person, and the link to open, sent as it is. */
  startSignIn: (agent: string, name: string) =>
    call<{ say: string; link?: string }>(`/agents/${agent}/connections/${encodeURIComponent(name)}/sign-in`, {}),
  /** Finish it with the code, or the address the browser landed on. */
  finishSignIn: (agent: string, name: string, answer: string) =>
    call<{ said: string }>(`/agents/${agent}/connections/${encodeURIComponent(name)}/finish`, { answer }),
  file: (agent: string, path: string) =>
    call<Opened>(`/agents/${agent}/file?path=${encodeURIComponent(path)}`),
  save: (agent: string, path: string, content: string) =>
    call<{ path: string; bytes: number }>(`/agents/${agent}/file`, { path, content }),
  threads: (agent: string) => call<Thread[]>(`/agents/${agent}/threads`),
  visitors: (agent: string) => call<Visitor[]>(`/agents/${agent}/web/visitors`),
  said: (thread: string) => call<Said[]>(`/threads/${encodeURIComponent(thread)}`),
  renameThread: (thread: string, label: string) =>
    call<{ thread: string; label: string | null }>(`/threads/${encodeURIComponent(thread)}/rename`, { label }),
  archiveThread: (thread: string, archived: boolean) =>
    call<{ thread: string; archived: string | null }>(`/threads/${encodeURIComponent(thread)}/archive`, { archived }),
  forget: (thread: string) => call<unknown>(`/threads/${encodeURIComponent(thread)}/forget`, {}),
  /** Pictures go with this turn only: the runtime keeps the line saying they were attached, never the picture. */
  say: (agent: string, prompt: string, thread: string, images: Picture[] = []) =>
    call<{ runId: string; text: string; cost: number }>(`/agents/${agent}/chat`, images.length ? { prompt, thread, images } : { prompt, thread }),

  /** Tokens, for another system. The secret comes back once, when it is made. */
  tokens: () => call<Token[]>("/tokens"),
  makeToken: (name: string, agent?: string) => call<Token & { secret: string }>("/tokens", { name, ...(agent && { agent }) }),
  revokeToken: (id: string) => call<Token>(`/tokens/${id}/revoke`, {}),

  /** Where an agent remembers things. Every agent has one. */
  memory: (agent: string) => call<Entry[]>(`${memoryOf(agent)}`),
  memoryFile: (agent: string, path: string) =>
    call<MemoryFile>(`${memoryOf(agent)}/file?path=${encodeURIComponent(path)}`),
  saveMemory: (agent: string, path: string, content: string) =>
    call<{ path: string; bytes: number }>(`${memoryOf(agent)}/file`, { path, content }),
  renameMemory: (agent: string, from: string, to: string) =>
    call<{ from: string; to: string }>(`${memoryOf(agent)}/rename`, { from, to }),
  deleteMemory: (agent: string, path: string) => call<{ deleted: string }>(`${memoryOf(agent)}/delete`, { path }),
  /** A pass to show that memory's files in a frame. It runs out in ten minutes. */
  memoryPass: (agent: string) => call<{ pass: string; at: string }>(`${memoryOf(agent)}/pass`),
  memoryLog: (agent: string, limit = 200) => call<MemoryRead[]>(`/agents/${agent}/memory/log?limit=${limit}`),
  git: (agent: string) => call<Git>(`/agents/${agent}/memory/git`),
  commit: (agent: string, message: string) =>
    call<{ commit: string; files: number }>(`/agents/${agent}/memory/git/commit`, { message }),
  push: (agent: string) => call<{ pushed: number; upstream: string; url?: string }>(`/agents/${agent}/memory/git/push`, {}),
  pull: (agent: string) => call<{ output: string }>(`/agents/${agent}/memory/git/pull`, {}),

  /** What an agent changed, in its memory and its own folder. `path` is one file's history. */
  changes: (agent: string, { place, path, limit = 50 }: { place?: Place; path?: string; limit?: number } = {}) =>
    call<Changes>(
      `/agents/${agent}/changes?limit=${limit}${place ? `&in=${place}` : ""}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
    ),
  change: (agent: string, place: Place, id: string) => call<Change & { diff: string }>(`/agents/${agent}/changes/${id}?in=${place}`),
  seen: (agent: string) => call<{ seen: string }>(`/agents/${agent}/changes/seen`, {}),
  undo: (agent: string, place: Place, id: string) =>
    call<{ id?: string; files: string[] }>(`/agents/${agent}/changes/${id}/undo`, { in: place }),
};

/**
 * A cloud's own routes: the account, and the workspaces it hosts. Always on
 * "/api" of the host the page came from, whichever workspace is open.
 */
export const cloud = {
  /** The same as api.account, of the host the page came from: which form to show, and who may sign up. */
  account: () => call<Account>("/account", undefined, CLOUD),
  signIn: (email: string, password: string) => call<{ ok: true; email: string }>("/login", { email, password }, CLOUD),
  signUp: (email: string, password: string, invite: string) =>
    call<{ ok: true; email: string }>("/signup", { email, password, invite }, CLOUD),
  signOut: () => call<{ ok: true }>("/logout", {}, CLOUD),
  /** No invite code: leave an address for whoever runs the cloud. Asking twice does nothing. */
  waitlist: (email: string) => call<{ ok: true }>("/waitlist", { email }, CLOUD),
  me: () => call<Me>("/me", undefined, CLOUD),
  /** The name the page calls you. The address is not changed here. */
  setName: (name: string) => call<Me>("/me", { name }, CLOUD),
  /** The chat the front page opens. Null goes back to the first agent there is. */
  setHome: (home: Home | null) => call<Me>("/me", { home }, CLOUD),
  workspaces: () => call<Workspace[]>("/workspaces", undefined, CLOUD),
  workspace: (name: string) => call<Workspace>(`/workspaces/${encodeURIComponent(name)}`, undefined, CLOUD),
  /** The key comes back once, in this reply, and the cloud never has it again. */
  make: (label: string) => call<{ workspace: Workspace; key: string }>("/workspaces", { label }, CLOUD),
  rename: (name: string, label: string) =>
    call<Workspace>(`/workspaces/${encodeURIComponent(name)}/rename`, { label }, CLOUD),
  newKey: (name: string) =>
    call<{ workspace: Workspace; key: string }>(`/workspaces/${encodeURIComponent(name)}/key`, {}, CLOUD),
  revoke: (name: string) => call<Workspace>(`/workspaces/${encodeURIComponent(name)}/revoke`, {}, CLOUD),
  remove: (name: string) => call<{ deleted: string }>(`/workspaces/${encodeURIComponent(name)}/delete`, {}, CLOUD),
  audit: (name: string, limit = 200) =>
    call<Relayed[]>(`/workspaces/${encodeURIComponent(name)}/audit?limit=${limit}`, undefined, CLOUD),
  /** Who is let in to the workspace's agents, and the invitations still open. The owner's. */
  people: (name: string) => call<People>(`/workspaces/${encodeURIComponent(name)}/people`, undefined, CLOUD),
  /** Invites somebody to one agent. The link goes to them by mail and nowhere else. */
  letIn: (name: string, email: string, agent: string, given: Given[]) =>
    call<{ invited: string }>(`/workspaces/${encodeURIComponent(name)}/people`, { email, agent, given }, CLOUD),
  change: (name: string, email: string, agent: string, given: Given[]) =>
    call<People>(`/workspaces/${encodeURIComponent(name)}/people/change`, { email, agent, given }, CLOUD),
  letGo: (name: string, email: string, agent: string) =>
    call<People>(`/workspaces/${encodeURIComponent(name)}/people/remove`, { email, agent }, CLOUD),
  /** What an invitation is for. Answered without a session, to whoever holds the code. */
  invitation: (code: string) => call<Invitation>(`/invitations/${encodeURIComponent(code)}`, undefined, CLOUD),
  /** Takes an invitation, signed in to the account with the address it was sent to. */
  accept: (code: string) => call<{ agent: string; workspace: string }>(`/invitations/${encodeURIComponent(code)}/accept`, {}, CLOUD),
};

/** One line of a memory's audit log. */
export interface MemoryRead {
  at: string;
  what: "read" | "write" | "list" | "serve" | "rename" | "delete" | "commit" | "push" | "pull" | "history" | "undo";
  path: string;
  from: string;
  bytes?: number;
}

/** One route out of GET /api. */
export interface RouteDoc {
  method: string;
  path: string;
  does: string;
  takes?: string;
  who: "anybody" | "account or token" | "account";
  needsApiChannel?: boolean;
}

/**
 * What the server at the other end can do: a runtime, or a cloud in front of
 * many. The page asks rather than assumes.
 */
export interface Serves {
  agents: boolean;
  tokens: boolean;
  /** Many runtimes, each reached through this one: a cloud. */
  cloud: boolean;
}

/** What to assume when the server cannot say: the full runtime. */
export const EVERYTHING: Serves = { agents: true, tokens: true, cloud: false };

/** Read from GET /api, the list of routes every server here answers. */
export function servesFrom(routes: { method: string; path: string }[]): Serves {
  const has = (path: string) => routes.some((one) => one.method === "GET" && one.path === `/api${path}`);
  return { agents: has("/agents"), tokens: has("/tokens"), cloud: has("/workspaces") };
}
