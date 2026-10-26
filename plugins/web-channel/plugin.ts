// A chat box on a web page, for anybody who visits the sites an agent's web
// channel names. Visitors are guests, what they may spend is capped, and only
// the site's own server gets a visitor a pass. The box itself is chat/, plain
// JavaScript served at /api/web/.
import { money, spentText } from "#chloe/core/turn";
import type { Agent } from "#chloe/load/load";
import type { Plugin } from "#chloe/load/plugin";
import { PASS_HEADER, spent, webClear, webFile, webHistory, webOrigins, webPass, webTurn, webUsage, webVisitors } from "./routes.ts";
import { webOf } from "./web.ts";

/** What the Channels page says about an agent's chat box: where it is, and what the last day came to. */
function doing(agent: Agent): string | undefined {
  const web = webOf(agent);
  if (!web) return undefined;
  const day = spent(agent.id);
  return (
    `A chat box on a web page, for anybody who visits ${web.origins.join(" or ")}. ` +
    `The last 24 hours: ${day.visitors} ${day.visitors === 1 ? "visitor" : "visitors"}, ${day.messages} ${day.messages === 1 ? "message" : "messages"}, ` +
    (day.unpriced
      ? `${spentText(day.dollars, day.unpriced)} spent, because ${day.unpriced} ${day.unpriced === 1 ? "answer" : "answers"} came with no price, so it refuses visitors until those are a day old.`
      : `${money(day.dollars)} of the ${money(web.limits.perDay.dollars)} it may spend.`)
  );
}

export const webChannel: Plugin = {
  name: "web-channel",
  channels: [
    {
      name: "web",
      fn: "webChannel",
      label: "Chat box on a website",
      does: "A chat box on a web page, for anybody who visits the sites you name. Visitors are guests.",
      fields: [
        { name: "origins", label: "Sites that may show it", about: "Each a scheme and a host with no path, like https://myshop.com.", kind: "list", default: [], required: true },
        { name: "greeting", label: "Greeting", about: "What the chat box shows before anybody has written.", kind: "words", default: "" },
        { name: "pictures", label: "Pictures", about: "Let a visitor send pictures, up to 2 in one message.", kind: "yesno", default: false },
        { name: "limits.perVisitor.messages", label: "Messages for each visitor", about: "The most in 24 hours.", kind: "number", default: 30 },
        { name: "limits.perVisitor.dollars", label: "Dollars for each visitor", about: "The most it may spend on one visitor in 24 hours.", kind: "number", default: 0.5 },
        { name: "limits.perDay.dollars", label: "Dollars for all visitors", about: "The most it may spend on all visitors together in 24 hours.", kind: "number", default: 5 },
      ],
      secrets: [],
      doing: (agent) => doing(agent),
    },
  ],
  routes: [
    // A chat box on a web page. The site's own server gets a visitor a pass with
    // a token made for that agent; the rest are open, because a visitor's page
    // holds no token, and each checks the pass instead and answers only the
    // sites the agent's web channel names. See routes.ts.
    {
      method: "POST",
      path: "/api/agents/:id/web/pass",
      does: "A visitor pass for that agent's web channel, good for an hour, and its greeting. For the site's own server, with a token made for that agent and no other.",
      takes: '{"visitor": "the site\'s own id for them", "facts": {"name": "optional, anything the agent should be told"}, "origin": "optional, the first of its origins unless said"}',
      token: true,
      handle: webPass,
    },
    {
      method: "GET",
      path: "/api/agents/:id/web/visitors",
      does: "Everybody that agent's web channel has had, newest first: when they came, their address, country and browser, and what their site said about them.",
      token: true,
      handle: webVisitors,
    },
    {
      method: "POST",
      path: `/api/agents/:id/web/turn`,
      does: `One turn for the visitor whose pass is in ${PASS_HEADER}, answered as a stream of events: text as it is written, a step as each tool starts, then done with the answer whole.`,
      takes: '{"text": "...", "timeZone": "optional, like Europe/Madrid, so it says the visitor\'s date", "images": [{"name": "...", "mediaType": "image/png", "data": "base64"}]}',
      open: true,
      origins: webOrigins,
      headers: [PASS_HEADER],
      handle: webTurn,
    },
    {
      method: "GET",
      path: "/api/agents/:id/web/history",
      does: `The conversation of the visitor whose pass is in ${PASS_HEADER}, oldest first, and the greeting.`,
      open: true,
      origins: webOrigins,
      headers: [PASS_HEADER],
      handle: webHistory,
    },
    {
      method: "POST",
      path: "/api/agents/:id/web/clear",
      does: `Forget the conversation of the visitor whose pass is in ${PASS_HEADER}.`,
      open: true,
      origins: webOrigins,
      headers: [PASS_HEADER],
      handle: webClear,
    },
    {
      method: "GET",
      path: "/api/web/chat.js",
      does: 'The chat box, for a page: <script src="/api/web/chat.js" data-agent="<id>" async></script>.',
      open: true,
      handle: (at) => webFile(at, "chat.js"),
    },
    {
      method: "GET",
      path: "/api/web/client.js",
      does: "What the chat box is built on, for a page with its own look: import { chloeChat } from it.",
      open: true,
      handle: (at) => webFile(at, "client.js"),
    },
    {
      method: "GET",
      path: "/api/agents/:id/web",
      does: "That agent's web channel: its sites, tools and limits, and how many visitors, messages and dollars the last 24 hours came to.",
      token: true,
      handle: webUsage,
    },
  ],
};
