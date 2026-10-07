// The shapes the server answers with. Every one of these is what a route in
// serve/ in chloejs returns, so a change there is a change here.

export interface AgentSummary {
  id: string;
  /** What to call it on the page, when that is not its id. */
  label?: string;
  description: string;
  model: string;
  /** The ways in it binds: telegram, api, whatever else. */
  channels: string[];
  /** Whether a token may chat to it or run its jobs. It binds an api channel. */
  api: boolean;
  /** What the site calls its memory. Every agent has one. */
  memory: string;
  tools: string[];
  skills: string[];
  jobs: { id: string; description?: string; cron?: string; when?: string; timezone: string; model: string; code?: boolean; files: string[] }[];
}

export interface RunRow {
  id: string;
  agent: string;
  started: string;
  finished: string | null;
  /** The channel it came in on, like "schedule", "telegram" or "terminal". */
  source: string;
  /** The job it was, or null when somebody started it by talking to the agent. */
  job?: string | null;
  model?: string;
  /** The start of what the person wrote, enough for a line. */
  asked?: string | null;
  reply?: string | null;
  steps: number;
  cost: number;
  error: string | null;
  summary?: string | null;
  /** When it was archived, or null. An archived run is left out of the log unless asked for. */
  archived?: string | null;
}

/** One line of what an agent did recently: a run, or several of the same in a row. */
export interface RecentWork {
  id: string;
  source: string;
  job?: string | null;
  started: string;
  finished: string | null;
  summary: string | null;
  error: string | null;
  times: number;
  failed: number;
  cost: number;
}

/**
 * A line of a run: a model answer, a tool call, or one step of a job.
 *
 * One shape for two: a prompt run writes LoopStep and a job writes Line, and
 * they agree on very little, so almost everything here is optional and which
 * fields are set says which kind of line it is.
 */
export interface Step {
  /** Set on a prompt run's lines: which turn of the loop it was. */
  step?: number;
  /** Set on a job's lines: its place in the order. */
  seq?: number;
  /** When it happened. Prompt runs from before 21 Sept 2026 did not keep it. */
  at?: string;
  say?: string;
  /** What the model wrote after its requests as if they had run. None of it ran. */
  dropped?: string;
  /** Set on the line where a run the service stopped picked up again. */
  carried?: string;
  /** Set on a prompt run's model line: the tools it asked for by name. */
  wants?: string[];
  cost?: number;
  tool?: string;
  args?: unknown;
  result?: unknown;
  /** Set on a job's lines. */
  kind?: "step" | "model" | "ask" | "agent";
  name?: string;
  ms?: number;
  note?: string;
  /** Set on a tool call the job would not allow. It never ran. */
  refused?: boolean;
  /** Set on a tool call that went back to the model as a failure, and on a job's line as why the step did not finish. */
  failed?: boolean | string;
  /** Set on an agent step: every tool it ran, and the ones it was not allowed to. */
  calls?: { toolName: string; input: unknown; output: unknown; refused?: boolean }[];
  /** Set on a model step: what it was asked. */
  prompt?: string;
  /** Set on an answered ask. */
  question?: string;
  reply?: string;
}

export interface Run extends RunRow {
  model: string;
  prompt: string;
  /** Every text message handed to the model before its first reply. */
  context?: string | null;
  reply: string | null;
  trace: Step[];
  /** Why it can pick up from where it stopped: the service stopped it, or it ran out of steps. False when it cannot. */
  carryOn?: "cut off" | "out of steps" | false;
  kind?: "turn" | "job";
  owner?: string | null;
  state?: string | null;
  parked?: string | null;
  /** The commits the run made, in its agent's memory or in its own folder. */
  commits?: RunCommit[];
}

/** Where an agent's changes are: its memory, or its own folder of instructions, skills and jobs. */
export type Place = "memory" | "folder";

/** A commit a run made, as its record keeps it. */
export interface RunCommit {
  in: Place;
  id: string;
  subject: string;
}

/** One commit to an agent's memory or its own folder. Paths are inside that place. */
export interface Change extends RunCommit {
  at: string;
  /** The agent's id for what it did, or whoever this box's git says for a person. */
  by: string;
  /** The run that made it, when a run did. */
  run?: string;
  files: { path: string; status: string }[];
  /** Made by the agent since somebody last looked. */
  new: boolean;
}

/** An agent's changes, newest first. */
export interface Changes {
  /** When somebody last looked, or null when nobody has. */
  seen: string | null;
  unseen: number;
  changes: Change[];
}

export interface ParkedRun {
  id: string;
  agent: string;
  job: string;
  who: string;
  question: string;
  asked: string;
  expires: string;
}

/** One thing in an agent's folder. A folder carries what is under it. */
export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  /** Bytes, for a file. */
  size?: number;
  /** When it last changed, as an ISO date. */
  modified?: string;
  children?: Entry[];
}

/** One thing out of an agent's folder: a folder answers with what is in it. */
export type Opened =
  | { path: string; dir: true; entries: Entry[] }
  | {
      path: string;
      dir: false;
      content: string;
      /** Markdown is written back from the page. Everything else is read only. */
      editable: boolean;
    };

/** One of an agent's skills: words it reaches for when it needs them. */
export interface Skill {
  name: string;
  description: string;
  body: string;
  /** The file it is, inside the agent's folder, which is where it is written back. */
  path: string;
}

/**
 * One way in or one way out. The runtime says which setting carries the
 * credentials and whether it is filled in, and never what is in it.
 */
export interface Way {
  name: string;
  does: string;
  /** The setting that carries its credentials, as a path, or empty when it needs none. */
  needs: string;
  /** Null when there is nothing to fill in. */
  ready: boolean | null;
  /** What is missing before it works, one line each, in words. Present for connections. */
  missing?: string[];
  /** Whether somebody can sign in to it from the page. */
  signIn?: boolean;
  /** How it was set up, as the agent's definition wrote it. Never a credential. */
  settings?: { name: string; value: string }[];
}

/** One thing an agent can do, and what the model is told it is for. */
export interface AgentTool {
  name: string;
  does: string;
}

/** One conversation an agent is in, whichever way it is reached. */
export interface Thread {
  thread: string;
  messages: number;
  last: string;
  /** What somebody named it, or null for the name it started with. */
  label?: string | null;
  /** When it was archived, or null. */
  archived?: string | null;
  /** The email of the guest it belongs to. Only the workspace's owner is told. */
  owner?: string | null;
}

export interface Said {
  role: "user" | "assistant";
  content: string;
  /** When it was said. A runtime from before this was sent leaves it out. */
  at?: string;
}

/** A picture sent with a chat turn, as base64 without the "data:" in front. */
export interface Picture {
  name: string;
  mediaType: string;
  data: string;
}

/** A token another system holds. The secret is only ever in the reply that made it. */
export interface Token {
  id: string;
  name: string;
  /** The one agent it reaches, when it was made for one. */
  agent?: string;
  created: string;
  lastUsed?: string;
  revoked?: string;
}

/** One file in an agent's memory, as text, for editing. */
export interface MemoryFile {
  path: string;
  dir: boolean;
  content?: string;
  bytes?: number;
  entries?: Entry[];
}

/** Source control for a memory. `repo` is false when the folder is not one. */
export type Git =
  | { repo: false }
  | {
      repo: true;
      branch: string;
      changes: { status: string; path: string }[];
      ahead: number;
      behind: number;
      upstream: string | null;
      log: { sha: string; date: string; author: string; subject: string }[];
    };

/**
 * What /api/account says before anybody is signed in: whether there is an
 * account yet, and on a cloud, whether somebody may make one and how.
 */
export interface Account {
  exists: boolean;
  cloud?: boolean;
  signup?: Signup;
  /** A copy somebody is working on, which says so across the top of the page. */
  dev?: boolean;
  /** The folder that copy is running out of. Only a dev copy says. */
  root?: string;
}

/** Who may make an account on a cloud: anybody, somebody with the invite code, or nobody. */
export type Signup = "invite" | "open" | "closed";

/** The signed-in account on a cloud. */
export interface Me {
  email: string;
  /** What the page calls you. Empty until it is set, and the address stands in for it. */
  name: string;
  /** The chat the front page opens. Null is the first agent there is. */
  home: Home | null;
  organizations: { id: string; name: string; role: string }[];
  /** What the cloud thinks this account should do next. Each goes away by itself once it is done. */
  notifications?: Notification[];
}

/** One note under the bell: a title, a line, and a button that goes to `to`, a path on this site. */
export interface Notification {
  id: string;
  title: string;
  text: string;
  button: string;
  to: string;
}

/** One agent in one workspace: where the front page of a cloud goes. */
export interface Home {
  workspace: string;
  agent: string;
}

/** One runtime a cloud hosts, as the cloud knows it from what the runtime last sent. */
export interface Workspace {
  /** Fixed, and what every address of its is under. Made from the label when it was created. */
  name: string;
  /** What to call it on the page. Free to change. */
  label: string;
  organization: string;
  created: string;
  online: boolean;
  lastSeen: string | null;
  coreVersion?: string;
  nodeVersion?: string;
  /** What the machine the runtime is on calls itself, as it last said. */
  machine?: string;
  protocol?: number;
  capabilities?: string[];
  remote?: { read: boolean; chat: boolean; run: boolean; memory: boolean; write: boolean };
  sync?: { runs: boolean; agents: boolean };
  /** The agents' ids. */
  agents: string[];
  today: { runs: number; failed: number; cost: number };
  keys: { id: string; created: string; lastUsed?: string; revoked?: string }[];
  /** Set when this account is a guest here: each agent it may reach, with what it was given on it. */
  guest?: Record<string, Given[]>;
}

/** What a guest can be given on an agent. */
export type Given = "chat" | "read" | "run" | "memory";

/** Everybody let in to a workspace's agents, and the invitations still open, as its owner sees them. */
export interface People {
  guests: { email: string; name: string; agent: string; given: Given[]; added: string }[];
  invited: { email: string; agent: string; given: Given[]; created: string; expires: string }[];
}

/** What an invitation is for, as the sign-up page shows it. */
export interface Invitation {
  email: string;
  workspace: string;
  agent: string;
  by: string;
  expires: string;
}

/** One request that went through the cloud to a workspace. */
export interface Relayed {
  at: string;
  user: string;
  from: string;
  method: string;
  path: string;
  status: number;
}

/** Somebody an agent's web channel has had, as its owner sees them. The model never sees `ip`. */
export interface Visitor {
  id: string;
  first: string;
  last: string;
  ip: string | null;
  country: string | null;
  browser: string | null;
  facts: Record<string, string>;
  thread: string;
}
