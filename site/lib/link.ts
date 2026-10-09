// A link the runtime printed carries a code after #in=. It is swapped for a
// session before the page asks for anything, and taken off the address first,
// so the history never holds it.
import { api } from "./api.ts";

/** Why the link this page was opened with did not sign it in, or "" when it did or there was none. */
export let linkTrouble = "";

export async function takeLink(): Promise<void> {
  const code = new URLSearchParams(window.location.hash.slice(1)).get("in");
  if (!code) return;
  history.replaceState(history.state, "", window.location.pathname + window.location.search);
  try {
    await api.link(code);
  } catch (error) {
    linkTrouble = (error as Error).message;
  }
}
