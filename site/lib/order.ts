// The order of the conversations somebody sorts by hand. No React.

/**
 * A list by where each was dragged to. One that was never dragged comes first,
 * as a new pin or a new chat in a group should, and they stay in the order given.
 */
export function byPlace<One extends { place?: number | null }>(list: One[]): One[] {
  const rank = (one: One) => one.place ?? -1;
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** The list with `one` in front of `before`, or at the end with null. It need not have been in the list. */
export function moved(list: string[], one: string, before: string | null): string[] {
  const rest = list.filter((each) => each !== one);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, one] : [...rest.slice(0, at), one, ...rest.slice(at)];
}
