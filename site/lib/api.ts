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
  Invitation,
  Me,
  MemoryFile,
  Opened,
  ParkedRun,
  People,
  Place,
  Run,
  RunRow,
  Said,
  Skill,
  Switch,
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
 */
let at = "/api";

/** Point the page at a runtime. Given nothing, says where it is pointed now. */
export function serverAt(address?: string): string {
  if (address) at = address.replace(/\/+$/, "");
  return at;
}

/**
 * Where a memory file is served for the frame it is shown in: the runtime hands
 * out `/memory/<pass>` and it hangs off the same place its API does.
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
 * What to say when a call comes back with nothing. A page pointed at another
 * runtime can be newer than it, so a route this page asks for may not exist
 * there. That is worth saying plainly rather than showing somebody the number
 * 404.
 */
export const missing = (error: Error, what: string): string =>
  /\b404\b|not found|not here/i.test(error.message)
    ? `This runtime does not answer for ${what}. It is running a chloe from before this page asked for it.`
    : error.message;

/** Where an agent's memory is answered. */
const memoryOf = (agent: string) => `/agents/${agent}/memory`;

/** The calls the login itself makes: a 401 from one of these is a wrong password. */
const GETTING_IN = ["/account", "/login", "/link"];
const gettingIn = (path: string): boolean => GETTING_IN.includes(path) || path.startsWith("/invitations/");

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${at}${path}`, {
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
    if (response.status === 401 && !gettingIn(path)) throw new NeedsSignIn();
    throw new Error(answer.error ?? `${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  /** Every route the server answers, with what each does and who may call it. Answered without a session. */
  routes: () => call<RouteDoc[]>(""),
  /** Whether this copy has a password yet, so the page knows which form to show. Answered without a session. */
  account: () => call<Account>("/account"),
  /** The owner signs in with the password alone. Somebody invited gives their email with theirs. */
  signIn: (password: string, email?: string) => call<Session>("/login", email ? { password, email } : { password }),
  /** The code from a link the runtime printed, swapped for a session. Each works once. */
  link: (code: string) => call<Session>("/link", { code }),
  /** The first password, from a browser already signed in. */
  setup: (password: string) => call<{ ok: true }>("/setup", { password }),
  signOut: () => call<{ ok: true }>("/logout", {}),
  /** Who is signed in: the owner, or somebody invited, with what they were given. */
  me: () => call<Me>("/me"),
  agents: () => call<AgentSummary[]>("/agents"),
  agent: (id: string) => call<AgentSummary>(`/agents/${id}`),
  /** The models somebody may pick for that agent. */
  models: (agent: string) => call<{ model: string; route: string }[]>(`/models?agent=${encodeURIComponent(agent)}`),
  /** Picks a model for "agent", "job:<id>" or "chat:<thread>". An empty model takes the pick back. */
  pickModel: (agent: string, scope: string, model: string) => call<AgentSummary>(`/agents/${agent}/model`, { scope, model }),
  health: () => call<{ agents: string[]; running: string[] }>("/health"),
  runs: (limit = 60, agent?: string) =>
    call<RunRow[]>(`/runs?limit=${limit}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`),
  log: (agent: string, limit = 60) => call<RunRow[]>(`/agents/${agent}/log?limit=${limit}`),
  run: (id: string) => call<Run>(`/runs/${id}`),
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

  /** What .env sets, by name. A value goes in and never comes back out. */
  keys: () => call<Key[]>("/keys"),
  setKeys: (lines: string) => call<Key[]>("/keys", { lines }),
  removeKey: (name: string) => call<Key[]>(`/keys/${encodeURIComponent(name)}/remove`, {}),
  /** chloe.config.ts. A save that would not load or type check is put back, and the reason is the error. */
  config: () => call<{ text: string }>("/config"),
  saveConfig: (text: string) => call<{ ok: true }>("/config", { text }),

  /** Tokens, for another system. The secret comes back once, when it is made. */
  tokens: () => call<Token[]>("/tokens"),
  makeToken: (name: string, agent?: string) => call<Token & { secret: string }>("/tokens", { name, ...(agent && { agent }) }),
  revokeToken: (id: string) => call<Token>(`/tokens/${id}/revoke`, {}),

  /** People the owner invites. The link to send comes back once, when it is made: nothing is mailed. */
  people: () => call<People>("/people"),
  invite: (email: string, name: string, agent: string, given: Switch[]) =>
    call<{ code: string; path: string }>("/people", { email, name, agent, given }),
  changePerson: (email: string, agent: string, given: Switch[]) => call<People>("/people/change", { email, agent, given }),
  removePerson: (email: string, agent: string) => call<People>("/people/remove", { email, agent }),
  /** Answered without a session: what an invitation is for, and taking it, which signs this browser in. */
  invitation: (code: string) => call<Invitation>(`/invitations/${encodeURIComponent(code)}`),
  accept: (code: string, password: string, name: string) =>
    call<Session>(`/invitations/${encodeURIComponent(code)}/accept`, { password, name }),

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

/** A name .env sets, and whether chloe.config.ts hands it over as process.env.<name>. */
export interface Key {
  name: string;
  inConfig: boolean;
}

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

/** What the runtime at the other end can do. The page asks rather than assumes. */
export interface Serves {
  agents: boolean;
  tokens: boolean;
  people: boolean;
}

/** What to assume when the runtime cannot say: all of it. */
export const EVERYTHING: Serves = { agents: true, tokens: true, people: true };

/** Read from GET /api, the list of routes the runtime answers. */
export function servesFrom(routes: { method: string; path: string }[]): Serves {
  const has = (path: string) => routes.some((one) => one.method === "GET" && one.path === `/api${path}`);
  return { agents: has("/agents"), tokens: has("/tokens"), people: has("/people") };
}
