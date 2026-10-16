// The web: reading a page, and searching.

import { about, is } from "#chloe/ops/check";

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

  const { duckDuckGoResults } = await import("./searchService.ts");
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
