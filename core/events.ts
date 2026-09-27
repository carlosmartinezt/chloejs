// What the runners say as they write the run history, for anything in the
// process that wants to hear it without reading the database over and over.
// Imports nothing, so core/ keeps its rule.
import { EventEmitter } from "node:events";

/** `run` carries the id of a run whose row was just written: started, finished or failed. */
export const events = new EventEmitter<{ run: [id: string] }>();

/** Says a run's row changed. Called by the two runners and nothing else. */
export function runChanged(id: string): void {
  events.emit("run", id);
}
