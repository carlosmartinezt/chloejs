// Sending one email.
//
// The caller supplies who it is from and who it is to. Which provider carries
// it is email.provider in settings, and each provider reads its own section
// of settings.local.json for its key (resend.api_key for Resend).
//
// The tool a model reaches is model/tools/send_email.ts, which calls
// this. A job calls this directly, from a step.

import { setting, settings } from "#chloe/core/settings.ts";

/**
 * Who an agent's mail comes from, who it goes to, and the tag in front of
 * every subject.
 */
export interface EmailSender {
  /** The From line, e.g. "Backups <info@example.com>". */
  from: string;
  /** Who it goes to. */
  to: string[];
  /** Prefix put in front of every subject, so an inbox can be filtered. */
  tag?: string;
  /** Where a reply goes, when not to `from`: a sending address that cannot receive mail needs this. */
  replyTo?: string[];
  /**
   * The body is Markdown: it is sent as HTML with headings, lists, tables and
   * links, plus a plain text copy without the symbols. Off, it is sent as
   * written, as plain text only.
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

const resend: EmailProvider = {
  async send({ from, to, replyTo, subject, body, html }) {
    const key = setting(settings.resend.api_key, "RESEND_API_KEY");
    if (!key) throw new Error("No Resend key. Put it in settings.local.json as resend.api_key.");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, reply_to: replyTo, subject, text: body, html }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Resend refused the message (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as { id?: string };
  },
};

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
const providers: Record<typeof settings.email.provider, EmailProvider> = { resend, none };

/** Sends one email through the configured provider and returns its id. The tag is put in front of the subject. */
export async function sendEmail(
  { from, to, tag, replyTo, markdown }: EmailSender,
  subject: string,
  body: string,
): Promise<{ sent: true; id?: string; subject: string }> {
  // Refuse rather than send nowhere.
  if (to.length === 0) throw new Error("Nobody to send to. Give the sender at least one address in to.");
  const tagged = tag && !subject.startsWith(`[${tag}]`) ? `[${tag}] ${subject}` : subject;
  const chosen = setting(settings.email.provider, "EMAIL_PROVIDER") as typeof settings.email.provider;
  const provider = providers[chosen];
  if (!provider) throw new Error(`No email provider called "${chosen}". It is one of: ${Object.keys(providers).join(", ")}.`);
  const { id } = await provider.send({
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
 * Markdown as email HTML: `##` headings, `-` lists, `|` tables, `>` quotes,
 * fenced code, **bold**, `code` and links. Lines next to each other are one
 * paragraph, so a body wrapped at any width reads as prose rather than as a
 * ragged line per paragraph. Only a blank line starts a new one.
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

/** The same Markdown as plain text: no `#`, `**` or backticks, a table row as `a: b`, a link as `words (address)`. */
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
