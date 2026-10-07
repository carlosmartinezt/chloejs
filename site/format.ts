/** "4 min ago", "yesterday", or the date when it is further back than a week. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 2 * 86400) return "yesterday";
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} days ago`;
  return day(iso);
}

export function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function exact(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** What a run cost, or a dash when it cost nothing. */
export function money(cost: number): string {
  if (!cost) return "–";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

export function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}
