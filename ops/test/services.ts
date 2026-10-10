// Services: email in Markdown, web pages, and a copy of the database.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, is } from "#chloe/ops/check";
import { db, sent } from "./shared.ts";

{
  about("an email written in Markdown");

  const { markdownToHtml, markdownToText } = await import("@chloejs/core/services");
  const body = "## Today\n\nOne line\nwrapped here.\n\n- a **bold** item\n- [a link](https://example.com)\n\n| day | visits |\n|---|---|\n| Mon | 3 |";
  const html = markdownToHtml(body);
  is("lines next to each other are one paragraph", html.includes("<p style='margin:0 0 14px'>One line wrapped here.</p>"), true);
  is("a heading is a heading", html.includes(">Today</div>"), true);
  is("a list is a list", (html.match(/<li /g) ?? []).length, 2);
  is("a table keeps its rows and drops the rule", (html.match(/<tr>/g) ?? []).length, 2);
  is("what a person typed is escaped", markdownToHtml("<b>hi</b>").includes("&lt;b&gt;"), true);
  is("a link that is not a web or mail address is only words", markdownToHtml("[go](javascript:alert(1))").includes("<a"), false);
  is("a quote cannot end the address early", markdownToHtml("[go](https://x.com/'onmouseover='y)").includes("href='https://x.com/&#39;onmouseover=&#39;y'"), true);
  is(
    "the plain copy has no symbols in it",
    markdownToText(body),
    "Today\n\nOne line\nwrapped here.\n\n- a bold item\n- a link (https://example.com)\n\n  day: visits\n  Mon: 3",
  );
}

{
  about("a provider that carries nothing");

  const { deliverEmail } = await import("@chloejs/core/services");
  const sent = await deliverEmail({ from: "a@example.com", to: ["b@example.com"], tag: "test" }, "Hello", "A body.");
  is("it says it was sent, with the tag in front", [sent.sent, sent.subject], [true, "[test] Hello"]);
  is("and it has no id, because nothing carried it", sent.id, undefined);

  const nobody = await deliverEmail({ from: "a@example.com", to: [] }, "Hello", "A body.").catch((error: Error) => error.message);
  is("nobody to send to is refused rather than dropped", nobody, "Nobody to send to. Give the sender at least one address in to.");
}

{
  about("reading a web page");

  const { feedToText, htmlToText, isPrivate, readPage } = await import("@chloejs/core/services");
  const atom =
    '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>r/Chess</title>' +
    '<link rel="self" href="https://www.reddit.com/r/chess/.rss"/><entry><author><name>/u/someone</name></author>' +
    '<content type="html">&lt;p&gt;Which site &lt;b&gt;analyses&lt;/b&gt; games best?&lt;/p&gt;</content>' +
    '<link rel="replies" href="https://www.reddit.com/r/chess/comments/abc/.rss"/>' +
    '<link href="https://www.reddit.com/r/chess/comments/abc/which_site/"/><published>2026-09-30T12:40:50+00:00</published>' +
    "<title>Which site &amp; why?</title></entry></feed>";
  const feed = feedToText(atom, "https://www.reddit.com/r/chess/.rss");
  is("a feed's own title is read", feed.title, "r/Chess");
  is(
    "an Atom entry is its title as a link, who and when, then its words unescaped",
    feed.text,
    "[Which site & why?](https://www.reddit.com/r/chess/comments/abc/which_site/)\n/u/someone, 2026-09-30T12:40:50+00:00\nWhich site analyses games best?",
  );
  const rss =
    '<rss version="2.0"><channel><title>News</title><item><title><![CDATA[One & two]]></title>' +
    "<link>https://example.com/one</link><pubDate>Tue, 30 Sep 2026 12:00:00 GMT</pubDate>" +
    "<description><![CDATA[<p>First</p><p>Second</p>]]></description></item></channel></rss>";
  is(
    "an RSS item reads the same, CDATA taken as it is",
    feedToText(rss, "https://example.com/").text,
    "[One & two](https://example.com/one)\nTue, 30 Sep 2026 12:00:00 GMT\nFirst\nSecond",
  );
  const html =
    "<!doctype html><html><head><title>Wall &amp; chart</title><style>td{}</style></head><body>\n" +
    "<table>\n<tr><td><a href=\"report.php?section=Novice - under 900\">Novice</a></td>\n<td>239</td></tr>\n" +
    "<tr><td>Sapp,&nbspNalani</td><td>W&nbsp120</td></tr></table><script>alert(1)</script></body></html>";
  const read = htmlToText(html, "https://example.com/events/");
  is("the title is read", read.title, "Wall & chart");
  is(
    "a row is one line, a link keeps its full address, and scripts are gone",
    read.text,
    "[Novice](https://example.com/events/report.php?section=Novice%20-%20under%20900) | 239\nSapp, Nalani | W 120",
  );
  is("loopback is private", isPrivate("127.0.0.1"), true);
  is("a home network is private", isPrivate("192.168.1.20"), true);
  is("loopback written as IPv6 is private", isPrivate("::ffff:127.0.0.1"), true);
  is("loopback carried in IPv6 as hex is private", isPrivate("::ffff:7f00:1"), true);
  is("a home network translated to IPv6 is private", isPrivate("64:ff9b::c0a8:114"), true);
  is("link local IPv6 is private", isPrivate("fe80::1"), true);
  is("a public address is not", isPrivate("104.21.3.4"), false);
  is("a public IPv6 address is not", isPrivate("2606:4700::6810:84e5"), false);
  const hexLoopback = await readPage("http://[::ffff:7f00:1]:3067/").then(() => "read", (error: Error) => error.message);
  is("loopback in IPv6 hex is refused", hexLoopback, "[::ffff:7f00:1] is a private address, and those are not read.");
  const byName = await readPage("http://localhost:3067/").then(() => "read", (error: Error) => error.message);
  is("a name that resolves to loopback is refused when connecting", byName, "localhost is a private address, and those are not read.");
  const refused = await readPage("http://127.0.0.1:3067/").then(() => "read", (error: Error) => error.message);
  is("this box's own ports are refused", refused, "127.0.0.1 is a private address, and those are not read.");
}

{
  about("searching the web");

  const { duckDuckGoResults } = await import("#chloe/services/searchService");
  const page =
    '<div class="result results_links results_links_deep result--ad "><a class="result__a" href="https://ads.example/">Buy</a></div>' +
    '<div class="result results_links results_links_deep web-result "><h2 class="result__title">' +
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fai%2Devents%3Fcity%3Dnyc&amp;rut=abc">AI &amp; <b>events</b></a></h2>' +
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The best <b>AI</b> events\n in NYC</a></div>';
  is(
    "a result is its own address, its title and its line as plain text, and an ad is left out",
    duckDuckGoResults(page),
    [{ title: "AI & events", url: "https://example.com/ai-events?city=nyc", snippet: "The best AI events in NYC" }],
  );
}

{
  about("a copy of the agents' database");

  const { copyDatabase } = await import("@chloejs/core");
  const { DatabaseSync } = await import("node:sqlite");
  const { tmpdir } = await import("node:os");
  const to = join(tmpdir(), `copy-${process.pid}`, "agents.db");
  const copied = await copyDatabase(to);
  const opened = new DatabaseSync(to, { readOnly: true });
  const count = (from: typeof db) => (from.prepare("select count(*) as n from runs").get() as { n: number }).n;
  is("it is written where it was asked for", copied.path, to);
  is("it opens, and holds every run", count(opened), count(db));
  opened.close();
  await rm(join(tmpdir(), `copy-${process.pid}`), { recursive: true, force: true });
}

{
  about("an alert when a job starts failing or works again");

  const { jobTurned } = await import("#chloe/core/alerts");
  const ended = (id: string, finished: string, error: string | null) =>
    db
      .prepare("insert into runs (id, agent, started, finished, source, model, prompt, error, job) values (?, 'alerted', ?, ?, 'schedule', 'm', '', ?, 'daily')")
      .run(id, finished, finished, error);
  ended("alert-1", "2026-01-01T10:00:00.000Z", null);
  is("a run that works after one that worked says nothing", jobTurned("alerted", "daily", "2026-01-01T09:59:00.000Z"), null);
  ended("alert-2", "2026-01-02T10:00:00.000Z", "claude exited 1: error_max_turns");
  is("the first failure says so, with the error", jobTurned("alerted", "daily", "2026-01-02T09:59:00.000Z")?.subject, "alerted/daily is failing");
  ended("alert-3", "2026-01-03T10:00:00.000Z", "claude exited 1: error_max_turns");
  is("a failure after a failure says nothing", jobTurned("alerted", "daily", "2026-01-03T09:59:00.000Z"), null);
  is("a run that left no row says nothing about an older one", jobTurned("alerted", "daily", "2026-01-04T09:59:00.000Z"), null);
  ended("alert-4", "2026-01-04T10:00:00.000Z", null);
  is("working again says so, once", jobTurned("alerted", "daily", "2026-01-04T09:59:00.000Z")?.subject, "alerted/daily works again");
}

{
  about("the guides an agent reads to learn what it could be given");

  const { guides, guide } = await import("#chloe/services/selfService");
  const all = guides();
  is("every guide is listed, with what it covers", all.some((one) => one.page === "connections" && one.about.length > 0), true);
  is("one is read whole by its name", guide("connections").includes("Google"), true);
  let refused = "";
  try {
    guide("../package");
  } catch (error) {
    refused = (error as Error).message;
  }
  is("a path out of the guides is no guide", refused.startsWith("There is no guide called ../package"), true);
}
