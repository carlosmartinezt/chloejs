// Every call the page makes, to the API on the address it was served from.
// The shapes are what serve/http.ts answers; nothing here imports the runtime.
import { useCallback, useEffect, useState } from "react";

export interface Job {
  id: string;
  description?: string;
  cron?: string;
  /** The cron line in words, when it is one that can be said. */
  when?: string;
  timezone?: string;
  /** "code" for a job made of code. */
  model: string;
  code: boolean;
}

export interface Agent {
  id: string;
  label?: string;
  description?: string;
  model: string;
  channels: string[];
  /** Whether a token may chat to it or run its jobs. */
  api: boolean;
  /** What it calls its memory. */
  memory: string;
  tools: string[];
  skills: string[];
  jobs: Job[];
}

export interface Run {
  id: string;
  agent: string;
  started: string;
  finished: string | null;
  source: string;
  job: string | null;
  model: string;
  steps: number;
  cost: number;
  error: string | null;
  reply: string | null;
  summary: string | null;
  asked: string;
}

export interface Token {
  id: string;
  name: string;
  /** The one agent it reaches, when it was made for one. */
  agent?: string;
  created: string;
  lastUsed?: string;
  revoked?: string;
}

export interface RouteDoc {
  method: string;
  path: string;
  does: string;
  takes?: string;
  who: "anybody" | "account or token" | "account";
  needsApiChannel?: boolean;
}

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  children?: Entry[];
}

/** Sent on window when a call comes back 401, so the page shows the way in. */
export const SIGNED_OUT = "chloe-signed-out";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const answer = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!response.ok) throw new Error(answer.error ?? `The server answered ${response.status}.`);
  return answer as T;
}

export const api = {
  /** Resolves when signed in, throws when not. */
  check: () => call<void>("/check"),
  hasAccount: () => call<{ exists: boolean }>("/account").then((one) => one.exists),
  signIn: (password: string) => call<{ ok: boolean }>("/login", { password }),
  setUp: (password: string) => call<{ ok: boolean }>("/setup", { password }),
  signOut: () => call<{ ok: boolean }>("/logout", {}),

  agents: () => call<Agent[]>("/agents"),
  agent: (id: string) => call<Agent>(`/agents/${encodeURIComponent(id)}`),
  runs: (agent?: string, limit = 20) =>
    call<Run[]>(`/runs?limit=${limit}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`),

  tokens: () => call<Token[]>("/tokens"),
  makeToken: (name: string, agent?: string) => call<Token & { secret: string }>("/tokens", { name, agent }),
  revokeToken: (id: string) => call<Token>(`/tokens/${encodeURIComponent(id)}/revoke`, {}),

  memory: (agent: string) => call<Entry[]>(`/agents/${encodeURIComponent(agent)}/memory`),
  /** Where that memory's files are served for a frame, good for ten minutes. */
  memoryPass: (agent: string) => call<{ at: string }>(`/agents/${encodeURIComponent(agent)}/memory/pass`),

  routes: () => call<RouteDoc[]>(""),
};

/** What a call answered, whether it failed, and a way to ask again. */
export function useLoad<T>(load: () => Promise<T>, keys: unknown[]) {
  const [data, setData] = useState<T>();
  const [trouble, setTrouble] = useState("");
  const again = useCallback(load, keys);
  const reload = useCallback(() => {
    again().then(
      (got) => {
        setData(got);
        setTrouble("");
      },
      (error: Error) => setTrouble(error.message),
    );
  }, [again]);
  useEffect(reload, [reload]);
  return { data, trouble, reload };
}
