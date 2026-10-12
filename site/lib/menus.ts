// One dropdown open at a time.
//
// On a phone the bar's nav and a page's sidebar both drop down over the page,
// and the sidebar's drops above the bar's, so tapping the bar's menu while the
// sidebar's is open looks like it did nothing. Opening one closes the other.

type Watcher = (open: string | null) => void;

let showing: string | null = null;
const watchers = new Set<Watcher>();

/** Say which dropdown is open now, or null for none, and tell every watcher. */
export function announceMenu(which: string | null): void {
  showing = which;
  for (const watch of watchers) watch(showing);
}

/** Watch which dropdown is open. Returns a function that stops watching. */
export function watchMenu(watch: Watcher): () => void {
  watchers.add(watch);
  return () => void watchers.delete(watch);
}
