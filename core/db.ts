import { mkdirSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { STATE } from "./paths.ts";

/**
 * The run history and the conversations, in one file inside the state folder.
 * The tests set AGENTS_DB to ":memory:" so they never write into the real one.
 */
export const DATABASE = process.env.AGENTS_DB || `${STATE}/agents.db`;
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
// What the run was started with, when it was started by hand. Kept whole so a
// run that parks for a person comes back to the same input it began with.
added("runs", "input", "text");
// The job this run was, or null for a turn somebody started by talking to it.
// `source` is then only the channel it came in on.
if (added("runs", "job", "text")) {
  // Before this column a job's run kept its id in `source`, and where it came
  // from is only known from what it was started with.
  db.exec(`
    update runs set job = source,
      source = case
        when json_valid(input) and json_extract(input, '$.from') = 'telegram' then 'telegram'
        when json_valid(input) and json_extract(input, '$.from') = 'terminal' then 'terminal'
        when json_valid(input) and coalesce(json_extract(input, '$.from'), '') != '' then 'api'
        else 'schedule'
      end
    where kind = 'job' and source != 'eval'
  `);
  db.exec("update runs set job = source, source = 'schedule' where kind = 'turn' and source not in ('telegram', 'chat', 'api', 'eval', 'studio')");
}
db.exec("update runs set source = 'terminal' where source = 'npm run'");
// The tools a reply called, as JSON, so the next turn knows how it was reached.
added("messages", "used", "text");
db.exec("create index if not exists runs_parked on runs (parked) where parked is not null");

/** Adds the column when it is missing, and says whether it did. */
function added(table: string, column: string, declaration: string): boolean {
  const there = db.prepare("select 1 from pragma_table_info(?) where name = ?").get(table, column);
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

/**
 * Close the runs a stop cut off. Every run happens in the service, so at
 * startup nothing is really running, and one with no end that is not waiting
 * on a person never gets one. Called once at startup.
 */
export function closeCutOff(): number {
  return Number(
    db
      .prepare("update runs set finished = ?, error = ? where finished is null and parked is null")
      .run(new Date().toISOString(), "Cut off: the service stopped while this was running.").changes,
  );
}

/** Drop runs older than this. Called once at startup. */
export function trim(keepDays = 60): void {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  db.prepare("delete from runs where started < ?").run(cutoff);
}
