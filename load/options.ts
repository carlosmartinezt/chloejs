// The fields of an ability or a channel: what each one is called, what kind of
// value it takes and what it is when unsaid. The loader checks an agent.ts
// against them, and the dashboard draws its form from them, so the two cannot
// disagree about what may be written.

/** The kinds of value a field takes. `list` is a list of words, or of numbers when `numbers` is set. */
export type OptionKind = "words" | "number" | "yesno" | "list" | "pick";

/** One field: a plain value an ability or a channel reads from agent.ts. */
export interface OptionSpec {
  /** What the file calls it. A name with a dot is inside a group, like `start.when` for `start: { when }`. */
  name: string;
  /** What the dashboard calls it. */
  label: string;
  /** One line on what it does, said to the person filling it in. */
  about: string;
  kind: OptionKind;
  /** What it is when the file does not say: empty words, 0, false, an empty list. */
  default?: string | number | boolean | (string | number)[];
  /** For `pick`: the words it may be. */
  pick?: string[];
  /** For `list`: the entries are numbers, like Telegram ids. */
  numbers?: boolean;
  /** It must be said for the ability or channel to work. */
  required?: boolean;
}

/** The value a field has when the file does not say it. */
export function defaultOf(spec: OptionSpec): unknown {
  if (spec.default !== undefined) return spec.default;
  return { words: "", number: 0, yesno: false, list: [], pick: spec.pick?.[0] ?? "" }[spec.kind];
}

/** Whether `value` is something this field takes. */
export function fits(spec: OptionSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "words":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "yesno":
      return typeof value === "boolean";
    case "pick":
      return typeof value === "string" && (spec.pick ?? []).includes(value);
    case "list":
      return Array.isArray(value) && value.every((one) => (spec.numbers ? typeof one === "number" : typeof one === "string"));
  }
}

/** What a field takes, in words, for a message that refuses a value. */
export function takes(spec: OptionSpec): string {
  switch (spec.kind) {
    case "words":
      return "words";
    case "number":
      return "a number";
    case "yesno":
      return "true or false";
    case "pick":
      return `one of ${(spec.pick ?? []).map((one) => JSON.stringify(one)).join(", ")}`;
    case "list":
      return spec.numbers ? "a list of numbers" : "a list of words";
  }
}

/** The value at a dotted name inside `given`, or undefined. */
export function valueAtName(given: unknown, name: string): unknown {
  return name.split(".").reduce<unknown>((at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined), given);
}

/**
 * What `given` (the object in agent.ts, or nothing for the defaults) says
 * for each field, with the default where it says nothing, as one flat object
 * keyed by the field's name. A value that is not what its field takes is
 * refused, saying what it takes. With `only`, a key that names no field is
 * refused too, and says which there are: an ability has no option beyond its
 * fields, where a channel passes the others on to its own code.
 */
export function readOptions(specs: OptionSpec[], given: unknown, where: string, only = false): Record<string, unknown> {
  if (given !== undefined && (given === null || typeof given !== "object" || Array.isArray(given))) {
    throw new Error(`${where} is true, false, or its fields written out like { ${specs[0]?.name ?? "field"}: ... }.`);
  }
  if (only) {
    const names = new Set(specs.map((one) => one.name));
    const groups = new Set(specs.filter((one) => one.name.includes(".")).map((one) => one.name.split(".")[0]));
    for (const key of Object.keys((given as object) ?? {})) {
      if (!names.has(key) && !groups.has(key)) throw new Error(`${where} has no field ${key}. It has ${specs.map((one) => one.name).join(", ")}.`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    const said = valueAtName(given, spec.name);
    if (said === undefined) {
      out[spec.name] = defaultOf(spec);
      continue;
    }
    if (!fits(spec, said)) throw new Error(`${where}: ${spec.name} takes ${takes(spec)}.`);
    out[spec.name] = said;
  }
  return out;
}

/** The field every ability that reaches something has: a few words for it, said to the model. */
export const about = (what: string): OptionSpec => ({
  name: "about",
  label: "Described as",
  about: `A few words for ${what}, said to the model. Optional.`,
  kind: "words",
  default: "",
});
