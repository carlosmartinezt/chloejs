// Code, cut into the pieces the page paints: a comment, a string, a number, a
// keyword, and everything else. Enough to read a file by, not a compiler.

export type Kind = "comment" | "string" | "number" | "keyword" | "plain";

export interface Piece {
  kind: Kind;
  text: string;
}

export type Language = "ts" | "sh" | "json" | "plain";

const WORDS: Record<Language, string[]> = {
  ts: ["as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default",
    "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from",
    "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
    "null", "of", "readonly", "return", "satisfies", "static", "switch", "this", "throw", "true",
    "try", "type", "typeof", "undefined", "var", "void", "while", "yield"],
  sh: ["case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if",
    "in", "local", "return", "set", "then", "until", "while"],
  json: ["false", "null", "true"],
  plain: [],
};

/**
 * One pass, in this order: a comment swallows what is inside it, then a
 * string, then a number, then a word that is a keyword. Anything a rule does
 * not claim is plain, so nothing is ever dropped and the pieces joined back
 * together are the file.
 */
const RULES: Record<Language, RegExp> = {
  ts: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\w.]*)|(?<![\w./-])([a-z]+)\b/g,
  sh: /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\b\d+\b)|(?<![\w./-])([a-z]+)\b/g,
  json: /(\/\/[^\n]*)|("(?:\\.|[^"\\\n])*")|(-?\b\d[\d.eE+-]*)|(?<![\w./-])([a-z]+)\b/g,
  plain: /(?!)/g,
};

export function tokens(text: string, language: Language): Piece[] {
  const rule = RULES[language];
  const words = WORDS[language];
  const out: Piece[] = [];
  let at = 0;

  const keep = (kind: Kind, part: string) => {
    if (!part) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += part;
    else out.push({ kind, text: part });
  };

  rule.lastIndex = 0;
  for (let found = rule.exec(text); found; found = rule.exec(text)) {
    const [whole, comment, string, number, word] = found;
    if (word && !words.includes(word)) continue;
    keep("plain", text.slice(at, found.index));
    keep(comment ? "comment" : string ? "string" : number ? "number" : "keyword", whole);
    at = found.index + whole.length;
  }
  keep("plain", text.slice(at));

  return out;
}

/** What a file is written in, from its name or from what a fence says it is. */
export function languageOf(name: string): Language {
  const said = name.trim().toLowerCase().split(/[.\s]/).pop() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "typescript", "javascript"].includes(said)) return "ts";
  if (["sh", "bash", "zsh", "shell", "console"].includes(said)) return "sh";
  if (said === "json") return "json";
  return "plain";
}
