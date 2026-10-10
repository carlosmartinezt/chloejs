import { languageOf, tokens } from "../../lib/code.ts";

/**
 * Code to write, painted like `Code`. The words typed go into a textarea whose
 * own letters are clear, laid over the painted copy in the same cell, so the
 * two wrap alike and the box grows with what is in it.
 */
export function CodeEditor({ text, language, onChange, label }: { text: string; language: string; onChange(text: string): void; label: string }) {
  const pieces = tokens(text, languageOf(language));
  return (
    <div className="code-editor">
      <pre className="painted" aria-hidden="true">
        {pieces.map((piece, at) =>
          piece.kind === "plain" ? (
            piece.text
          ) : (
            <span key={at} className={piece.kind}>
              {piece.text}
            </span>
          ),
        )}
        {/* A last line left empty still takes room, as it does in the textarea. */}
        {"\n "}
      </pre>
      <textarea spellCheck={false} autoCapitalize="off" autoComplete="off" value={text} onChange={(event) => onChange(event.target.value)} aria-label={label} />
    </div>
  );
}
