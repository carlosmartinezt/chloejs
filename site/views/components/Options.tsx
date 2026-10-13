import { useEffect, useState } from "react";

import type { OptionShown } from "../../lib/types.ts";

/** What a field holds as the person edits it: words, or a switch. */
type Draft = Record<string, string | boolean>;

/** A field's value as the input shows it. */
function shown(field: OptionShown): string | boolean {
  if (field.kind === "yesno") return field.value === true;
  if (field.kind === "list") return Array.isArray(field.value) ? field.value.join(", ") : "";
  return field.value === undefined || field.value === null ? "" : String(field.value);
}

/** What the input says, as the value the file takes, or an error in words. */
function read(field: OptionShown, said: string | boolean): { value: unknown } | { error: string } {
  if (field.kind === "yesno") return { value: said === true };
  const text = String(said).trim();
  if (field.kind === "number") {
    const value = Number(text);
    return text === "" || Number.isNaN(value) ? { error: `${field.label} takes a number.` } : { value };
  }
  if (field.kind === "list") {
    const each = text.split(/[,\n]/).map((one) => one.trim()).filter(Boolean);
    if (!field.numbers) return { value: each };
    const numbers = each.map(Number);
    return numbers.some(Number.isNaN) ? { error: `${field.label} takes numbers, separated by commas.` } : { value: numbers };
  }
  return { value: text };
}

/**
 * A form for the fields of an ability or a channel. It saves only what changed,
 * through `save`, which takes the field names and their new values. A field the
 * file writes as code is shown and cannot be edited here.
 */
export function Options({
  fields,
  save,
  busy,
  label = "Save",
  needed = false,
}: {
  fields: OptionShown[];
  save: (set: Record<string, unknown>) => Promise<void>;
  busy: boolean;
  /** What the button says. */
  label?: string;
  /** Every required field must be filled before the button works. */
  needed?: boolean;
}) {
  const start = (): Draft => Object.fromEntries(fields.map((one) => [one.name, shown(one)]));
  const [draft, setDraft] = useState<Draft>(start);
  const [problem, setProblem] = useState("");
  // What the file says now: after a save, or after a switch, the form starts again from it.
  const now = JSON.stringify(fields.map((one) => one.value));
  useEffect(() => {
    setDraft(start());
    setProblem("");
  }, [now]);

  const changed = fields.filter((one) => !one.code && draft[one.name] !== shown(one));
  const missing = needed ? fields.filter((one) => one.required && String(draft[one.name] ?? "").trim() === "") : [];

  const submit = async () => {
    const set: Record<string, unknown> = {};
    for (const one of changed) {
      const got = read(one, draft[one.name]);
      if ("error" in got) return setProblem(got.error);
      set[one.name] = got.value;
    }
    setProblem("");
    await save(set);
  };

  return (
    <div className="options">
      {fields.map((one) => {
        const common = { disabled: one.code || busy, id: `field-${one.name}` };
        return (
          <label key={one.name} className={one.kind === "yesno" ? "yesno" : ""} title={one.about}>
            <span className="name">
              {one.label}
              {one.required ? " (needed)" : ""}
            </span>
            {one.kind === "yesno" ? (
              <input type="checkbox" {...common} checked={draft[one.name] === true} onChange={(event) => setDraft({ ...draft, [one.name]: event.target.checked })} />
            ) : one.kind === "pick" ? (
              <select {...common} value={String(draft[one.name])} onChange={(event) => setDraft({ ...draft, [one.name]: event.target.value })}>
                {(one.pick ?? []).map((word) => (
                  <option key={word}>{word}</option>
                ))}
              </select>
            ) : (
              <input
                type={one.kind === "number" ? "number" : "text"}
                {...common}
                value={String(draft[one.name])}
                placeholder={one.kind === "list" ? "separate with commas" : String(Array.isArray(one.default) ? one.default.join(", ") : (one.default ?? ""))}
                onChange={(event) => setDraft({ ...draft, [one.name]: event.target.value })}
              />
            )}
            <span className="hint">{one.code ? "Written as code in agent.ts, so it is changed there. " : ""}{one.about}</span>
          </label>
        );
      })}
      {problem && <p className="bad">{problem}</p>}
      <button className="small" disabled={busy || changed.length === 0 || missing.length > 0} onClick={submit}>
        {busy ? "Saving" : label}
      </button>
      {missing.length > 0 && <span className="dim"> Fill in {missing.map((one) => one.label.toLowerCase()).join(", ")} first.</span>}
    </div>
  );
}
