import { mkdirSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { STATE } from "./paths.ts";

/**
 * The run history and the conversations, in one file inside the state folder.
 * Read as this file loads, which is before any config is, so it comes from the
 * environment as CHLOE_DB and is not a setting. The tests set it to ":memory:"
 * so they never write into the real one.
 */
export const DATABASE = process.env.CHLOE_DB || `${STATE}/agents.db`;
if (DATABASE !== ":memory:") mkdirSync(STATE, { recursive: true });

/** The SQLite handle every run, step and conversation is written to. */
export const db = new DatabaseSync(DATABASE);

// Without WAL, a long turn blocks the web page's reads.
db.exec("pragma journal_mode = wal");
db.exec("pragma busy_timeout = 5000");

db.exec(`
  create table if not exists messages (
    id        integer primary key autoincrement,
    thread    text    not null,
    role      text    not null,
    content   text    not null,
    at        text    not null
  );
  create index if not exists messages_thread on messages (thread, id);

  create table if not exists runs (
    id        text    primary key,
    agent     text    not null,
    started   text    not null,
    finished  text,
    source    text    not null,
    model     text    not null,
    prompt    text    not null,
    reply     text,
    error     text,
    steps     integer not null default 0,
    cost      real    not null default 0,
    trace     text    not null default '[]'
  );
  create index if not exists runs_agent on runs (agent, started desc);
`);

// Added after the first runs existed, so they are added rather than declared.
// A column that is already there is left alone, which is what makes this safe
// to run on every start.
added("runs", "kind", "text not null default 'turn'");
added("runs", "owner", "text");
added("runs", "state", "text");
added("runs", "parked", "text");
// One line saying what the run did, for the overview. A job writes its own.
added("runs", "summary", "text");
// A job's `args` and `work.input` were once columns called input and message.
if (!has("runs", "args") && has("runs", "input")) {
  db.exec("alter table runs rename column input to args");
  if (has("runs", "message")) db.exec("alter table runs rename column message to input");
}
// What the run was started with, as checked against the job's `args` shape.
// Kept whole so a run that parks for a person comes back to the same args.
added("runs", "args", "text");
// Where the run was started from and what was said, as JSON: `work.input`.
// Kept for the same reason, even when the job declares no `args` shape.
added("runs", "input", "text");
// The job this run was, or null for a turn somebody started by talking to it.
// `source` is then only the channel it came in on.
if (added("runs", "job", "text")) {
  // Before this column a job's run kept its id in `source`, and where it came
  // from is only known from what it was started with.
  db.exec(`
    update runs set job = source,
      source = case
        when json_valid(args) and json_extract(args, '$.from') = 'telegram' then 'telegram'
        when json_valid(args) and json_extract(args, '$.from') = 'terminal' then 'terminal'
        when json_valid(args) and coalesce(json_extract(args, '$.from'), '') != '' then 'api'
        else 'schedule'
      end
    where kind = 'job' and source != 'eval'
  `);
  db.exec("update runs set job = source, source = 'schedule' where kind = 'turn' and source not in ('telegram', 'chat', 'api', 'eval', 'studio')");
}
db.exec("update runs set source = 'terminal' where source = 'npm run'");
// The commits the run made, as JSON: [{ "in": "memory" | "folder", "id", "subject" }].
added("runs", "commits", "text");
// The tools a reply called, as JSON, so the next turn knows how it was reached.
added("messages", "used", "text");
// The messages handed to a model before its first answer. This is separate
// from prompt because a turn can recall earlier messages too.
added("runs", "context", "text");
// When somebody archived the run, or null. An archived run is kept whole and
// listed as before: it is the page that leaves it out of the log.
added("runs", "archived", "text");
db.exec("create index if not exists runs_parked on runs (parked) where parked is not null");

// What a person calls a conversation, when they archived it, and the email of
// the guest it belongs to. A row only for a conversation somebody has named or
// archived, or a guest has started: the rest have none, and are the owner's.
db.exec("create table if not exists threads (thread text primary key, label text, archived text)");
if (added("threads", "owner", "text")) {
  // A guest's conversation used to say whose it was in its id,
  // "<agent>/guest-<email>-<the rest>". Those keep their ids and get an owner.
  const rows = db.prepare("select distinct thread from messages where thread like '%/guest-%'").all() as { thread: string }[];
  const own = db.prepare("insert into threads (thread, owner) values (?, ?) on conflict (thread) do update set owner = excluded.owner");
  for (const { thread } of rows) {
    const email = /^[^/]+\/guest-(.+@.+?)-web(?:-|$)/.exec(thread)?.[1] ?? /^[^/]+\/guest-(.+@[^-]+)-/.exec(thread)?.[1];
    if (email) own.run(thread, email);
  }
}

// When somebody last looked at an agent's changes. One row per agent.
db.exec("create table if not exists seen (agent text primary key, at text not null)");

/**
 * The columns a run is listed by: GET /api/runs, an agent's log, and what is
 * sent to a dashboard. Only the start of the prompt, enough for a line; the
 * trace, the state and the whole prompt are left to GET /api/runs/:id.
 */
export const RUN_COLUMNS =
  "id, agent, started, finished, source, job, model, steps, cost, error, reply, summary, archived, substr(prompt, 1, 200) as prompt";

/** One commit a run made: in the agent's memory, or in the repo its own folder is in. */
export interface RunCommit {
  in: "memory" | "folder";
  id: string;
  subject: string;
}

/** Adds a commit to the run that made it. */
export function addCommit(runId: string, commit: RunCommit): void {
  db.prepare("update runs set commits = json_insert(coalesce(commits, '[]'), '$[#]', json(?)) where id = ?").run(
    JSON.stringify(commit),
    runId,
  );
}

/** Whether the table has the column. */
function has(table: string, column: string): boolean {
  return Boolean(db.prepare("select 1 from pragma_table_info(?) where name = ?").get(table, column));
}

/** Adds the column when it is missing, and says whether it did. */
function added(table: string, column: string, declaration: string): boolean {
  const there = has(table, column);
  if (!there) db.exec(`alter table ${table} add column ${column} ${declaration}`);
  return !there;
}

/**
 * A whole copy of the database in the file `to`, taken from the open
 * connection, so it is consistent even while runs are writing to it.
 */
export async function copyDatabase(to: string): Promise<{ path: string; bytes: number }> {
  await mkdir(dirname(to), { recursive: true });
  await backup(db, to);
  return { path: to, bytes: (await stat(to)).size };
}

/** What a run the service stopped in the middle of says as its error. */
export const CUT_OFF = "Cut off: the service stopped while this was running.";

/**
 * Close the runs a stop cut off. Every run happens in the service, so at
 * startup nothing is really running, and one with no end that is not waiting
 * on a person never gets one. Called once at startup.
 */
export function closeCutOff(): number {
  return Number(
    db
      .prepare("update runs set finished = ?, error = ? where finished is null and parked is null")
      .run(new Date().toISOString(), CUT_OFF).changes,
  );
}

/** Drop runs older than this. Called once at startup. */
export function trim(keepDays = 60): void {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  db.prepare("delete from runs where started < ?").run(cutoff);
}
