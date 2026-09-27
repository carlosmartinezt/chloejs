// A model somebody picked on the fly, kept in the database rather than in a
// file: for one chat, for one job, or for everything an agent does. The file
// stays the default and a choice here beats it, so the run record shows which
// model made each run and the choice can be undone from a chat or the API.
import { db } from "#chloe/core/db.ts";
import type { Agent, Job } from "#chloe/load/load.ts";

db.exec(`
  create table if not exists choices (
    agent text not null,
    scope text not null,
    model text not null,
    at    text not null,
    primary key (agent, scope)
  )
`);

/** "agent" for everything the agent does, "job:<id>" for one job, "chat:<thread>" for one conversation. */
export type Scope = "agent" | `job:${string}` | `chat:${string}`;

export interface Choice {
  scope: Scope;
  model: string;
  at: string;
}

/** Keeps a choice, or with an empty model takes it back. */
export function choose(agent: string, scope: Scope, model: string): void {
  if (!model) {
    db.prepare("delete from choices where agent = ? and scope = ?").run(agent, scope);
    return;
  }
  db.prepare("insert into choices (agent, scope, model, at) values (?, ?, ?, ?) on conflict (agent, scope) do update set model = excluded.model, at = excluded.at").run(
    agent,
    scope,
    model,
    new Date().toISOString(),
  );
}

/** The model chosen for one scope, or nothing. */
export function chosen(agent: string, scope: Scope): string | undefined {
  const row = db.prepare("select model from choices where agent = ? and scope = ?").get(agent, scope) as { model: string } | undefined;
  return row?.model;
}

/** Every choice kept for an agent, the agent's own first, then its jobs, then chats. */
export function choices(agent: string): Choice[] {
  const rows = db.prepare("select scope, model, at from choices where agent = ? order by scope").all(agent) as unknown as Choice[];
  const rank = (one: Choice) => (one.scope === "agent" ? 0 : one.scope.startsWith("job:") ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || a.scope.localeCompare(b.scope));
}

/**
 * The model a run goes to. For a job: what was chosen for that job, else what
 * the job names, else what was chosen for the agent, else what the agent
 * names. Without a job, the last two.
 */
export function modelFor(agent: Agent, job?: Job): string {
  const own = chosen(agent.name, "agent") ?? agent.model;
  if (!job) return own;
  return chosen(agent.name, `job:${job.id}`) ?? job.model ?? own;
}
