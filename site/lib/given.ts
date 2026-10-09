// What somebody the owner invited may see on the page, and where they land.
// The runtime refuses everything else anyway: this keeps the page from
// offering it. No React.
import type { View } from "./route.ts";
import type { Given, Switch } from "./types.ts";

/** What the page says on anything they were not given. */
export const NOT_GIVEN = "Its owner has not given you this.";

/** Whether they were given `what` on that agent. */
export const may = (given: Given, agent: string, what: Switch): boolean => (given[agent] ?? []).includes(what);

/**
 * Whether somebody invited may be on this page: a chat with chat, the log with
 * read, an agent's jobs with run or read, and the pages anybody may see.
 */
export function allowed(given: Given, view: View): boolean {
  switch (view.at) {
    case "chat":
      return may(given, view.agent, "chat");
    case "jobs":
      return may(given, view.agent, "run") || may(given, view.agent, "read");
    case "log":
      return view.agent ? may(given, view.agent, "read") : Object.keys(given).some((agent) => may(given, agent, "read"));
    case "signin":
    case "api":
    case "invitation":
      return true;
    default:
      return false;
  }
}

/**
 * Where to send somebody invited who is on a page they may not be: somewhere
 * on the agent they were on, if anywhere, then a chat, then jobs, then the log.
 * Null when they were given nothing on any of `agents`.
 */
export function landing(given: Given, agents: string[], from?: string): View | null {
  const pages = (agent: string): View[] => [
    { at: "chat", agent },
    { at: "jobs", agent },
    { at: "log", agent },
  ];
  const tried = [
    ...(from ? pages(from) : []),
    ...agents.map((agent): View => ({ at: "chat", agent })),
    ...agents.map((agent): View => ({ at: "jobs", agent })),
    ...agents.map((agent): View => ({ at: "log", agent })),
  ];
  return tried.find((one) => allowed(given, one)) ?? null;
}
