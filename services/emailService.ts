// Sending one email.
//
// The caller supplies who it is from and who it is to. Which provider carries
// it is email.provider in settings unless the caller names one, and each
// provider reads its own section of .env for its key (CHLOE_CONNECTIONS_RESEND_API_KEY for
// Resend). "none" in settings sends nothing at all, whoever names a provider.
//
// The tools a model reaches are gmail.sendEmail and resend.sendEmail, which call
// this. A job calls this directly, from a step.

import { holdBack } from "#chloe/core/current";
import { settings } from "#chloe/core/settings";

import { gmailProvider } from "#chloe/connections/google/gmailService";
import { resendProvider } from "#chloe/connections/resend/resendService";

/**
 * Who an email is from, who it goes to, and how it looks. You pass it to
 * `deliverEmail`.
 */
export interface EmailSender {
  /**
   * The From line, such as `"Backups <info@example.com>"`. Required.
   *
   * With the `"gmail"` provider, Google only keeps an address that is the
   * signed-in account or an alias set up in Gmail. It sends anything else
   * from the signed-in account.
   */
  from: string;
  /** The addresses the email goes to. Required, with at least one address. */
  to: string[];
  /**
   * A word put in square brackets at the start of every subject, so you can
   * filter your inbox. With `"backups"`, the subject `Done` becomes
   * `[backups] Done`. Off by default.
   */
  tag?: string;
  /**
   * Where replies go. If not set, replies go to `from`. Set it when the `from`
   * address cannot receive mail.
   */
  replyTo?: string[];
  /**
   * Treats the body as Markdown. The email is sent as HTML (headings, lists,
   * tables, links), plus a plain text copy without the Markdown symbols.
   *
   * Off by default: the body is sent as plain text, exactly as written.
   */
  markdown?: boolean;
}

/** One message, ready to go: the tag is already in the subject. */
export interface Email {
  from: string;
  to: string[];
  replyTo?: string[];
  subject: string;
  /** Plain text. */
  body: string;
  html?: string;
}

/** Something that can carry an email. Returns the provider's id for it, if it gives one. */
export interface EmailProvider {
  send(email: Email): Promise<{ id?: string }>;
}

/**
 * Carries nothing: the subject and who it was for go to the log and the
 * message is dropped. What a test run and a box with no mail account use, so
 * that code which mails can be exercised without anything leaving the box.
 */
const none: EmailProvider = {
  async send({ to, subject }) {
    console.log(`email (not sent, provider is none): "${subject}" to ${to.join(", ")}`);
    return {};
  },
};

/** Every provider email.provider can name. Adding one is an entry here and in the settings schema. */
const providers: Record<typeof settings.email.provider, EmailProvider> = { resend: resendProvider, gmail: gmailProvider, none };

/** A provider that actually sends. */
export type SendingProvider = Exclude<typeof settings.email.provider, "none">;

/**
 * Sends one email.
 *
 * - The first argument is an `EmailSender`: who it is from, who it goes to, and how it looks.
 * - `subject`: the subject line. If the sender has a `tag`, `[tag] ` is put in front of it.
 * - `body`: the text of the email. Plain text, or Markdown when the sender has `markdown: true`.
 * - `provider`: the service that sends it, `"resend"` or `"gmail"`. If not set, it uses `email.provider` from the settings.
 *
 * Returns `{ sent: true, id, subject }`: the id the provider gave the email
 * (if it gave one), and the subject as it was sent, with its tag.
 *
 * When `email.provider` in the settings is `"none"`, nothing is sent, even if
 * you pass `provider`. The subject is only written to the log, and the result
 * still says `sent: true`.
 *
 * In a trial run nothing is sent either: the run's record keeps the email,
 * and the result is `{ sent: false, held: true, subject }`.
 *
 * Throws if `to` is empty, or if the provider fails (for example: there is no
 * Resend key, or nobody has signed in to Google).
 */
export async function deliverEmail(
  { from, to, tag, replyTo, markdown }: EmailSender,
  subject: string,
  body: string,
  provider?: SendingProvider,
): Promise<{ sent: boolean; held?: true; id?: string; subject: string }> {
  // Refuse rather than send nowhere.
  if (to.length === 0) throw new Error("Nobody to send to. Give the sender at least one address in to.");
  const tagged = tag && !subject.startsWith(`[${tag}]`) ? `[${tag}] ${subject}` : subject;
  const chosen = settings.email.provider === "none" ? "none" : (provider ?? settings.email.provider);
  const carrier = providers[chosen];
  if (!carrier) throw new Error(`No email provider called "${chosen}". It is one of: ${Object.keys(providers).join(", ")}.`);
  if (holdBack({ kind: "email", to: to.join(", "), subject: tagged, text: body })) return { sent: false, held: true, subject: tagged };
  const { id } = await carrier.send({
    from,
    to,
    replyTo,
    subject: tagged,
    body: markdown ? markdownToText(body) : body,
    html: markdown ? markdownToHtml(body) : undefined,
  });
  return { sent: true, id, subject: tagged };
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

function inline(s: string): string {
  return escape(s)
    .replace(/`([^`]+)`/g, "<code style='background:#f1f1f1;padding:1px 4px;border-radius:3px'>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Only a web or mail address becomes a link, never javascript: or data:.
    .replace(LINK, (_, words, to) => (/^(https?:|mailto:)/i.test(to) ? `<a href='${to}'>${words}</a>` : words))
    .replace(/(?<!["'>=])(https?:\/\/[^\s<)]+)/g, "<a href='$1'>$1</a>");
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isRule = (row: string[]) => row.every((c) => /^[-: ]*$/.test(c));
const BULLET = /^\s*[-*] /;

/**
 * Turns Markdown into HTML for an email, with simple styles that mail apps show.
 *
 * - `markdown`: the Markdown text.
 *
 * It understands `#` headings, `-` and `*` lists, `|` tables, `>` quotes,
 * code blocks between ```` ``` ```` lines, `**bold**`, `` `code` ``,
 * `[words](address)` links and plain web addresses. A link works only for
 * `http:`, `https:` and `mailto:` addresses. Any other link becomes plain words.
 *
 * Lines next to each other join into one paragraph. Only a blank line starts a
 * new paragraph, so text wrapped at any width still reads as normal sentences.
 *
 * Returns the HTML as one string. It does not throw.
 */
export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  let para: string[] = [];
  let table: string[][] = [];
  const endPara = () => {
    if (para.length) out.push(`<p style='margin:0 0 14px'>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const endTable = () => {
    const rows = table.filter((r) => !isRule(r));
    table = [];
    if (!rows.length) return;
    const th = "padding:5px 10px;border-bottom:2px solid #d9d9d9;text-align:left";
    const td = "padding:5px 10px;border-bottom:1px solid #eee";
    const head = rows[0].map((c) => `<th style='${th}'>${inline(c)}</th>`).join("");
    const body = rows.slice(1).map((r) => `<tr>${r.map((c) => `<td style='${td}'>${inline(c)}</td>`).join("")}</tr>`);
    out.push(`<table style='border-collapse:collapse;margin:0 0 16px'><tr>${head}</tr>${body.join("")}</table>`);
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      endPara();
      endTable();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) code.push(escape(lines[i]));
      out.push(`<pre style='background:#f6f6f6;padding:10px;overflow:auto'>${code.join("\n")}</pre>`);
      i++;
    } else if (line.trimStart().startsWith("|") && line.split("|").length > 2) {
      endPara();
      table.push(cells(line));
      i++;
    } else if (!line.trim()) {
      endPara();
      endTable();
      i++;
    } else if (line.startsWith("#")) {
      endPara();
      endTable();
      const size = line.startsWith("###") ? 15 : 17;
      out.push(`<div style='font-size:${size}px;font-weight:700;margin:22px 0 10px'>${inline(line.replace(/^#+/, "").trim())}</div>`);
      i++;
    } else if (BULLET.test(line)) {
      endPara();
      endTable();
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i])) {
        let item = lines[i++].replace(BULLET, "");
        while (i < lines.length && lines[i].trim() && !/^\s*[-*] |^#|^\s*\||^> /.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(`<li style='margin:0 0 6px'>${inline(item)}</li>`);
      }
      out.push(`<ul style='margin:0 0 14px;padding-left:22px'>${items.join("")}</ul>`);
    } else if (line.startsWith("> ")) {
      endPara();
      endTable();
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) quote.push(lines[i++].slice(2).trim());
      out.push(`<blockquote style='margin:0 0 14px;padding-left:14px;border-left:3px solid #ccc'>${inline(quote.join(" "))}</blockquote>`);
    } else {
      endTable();
      para.push(line.trim());
      i++;
    }
  }
  endPara();
  endTable();
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;max-width:640px">${out.join("\n")}</div>`;
}

/**
 * Turns Markdown into plain text for an email.
 *
 * - `markdown`: the Markdown text.
 *
 * It removes `#`, `**` and backticks. A table row becomes `a: b`, and a link
 * becomes `words (address)`. Returns the text. It does not throw.
 */
export function markdownToText(markdown: string): string {
  return markdown
    .split("\n")
    .flatMap((line) => {
      if (line.trimStart().startsWith("|")) {
        const row = cells(line);
        return isRule(row) ? [] : [`  ${row.filter(Boolean).join(": ")}`];
      }
      return [line.replace(/^#+\s*/, "").replace(LINK, "$1 ($2)").replace(/\*\*/g, "").replace(/`/g, "")];
    })
    .join("\n");
}
