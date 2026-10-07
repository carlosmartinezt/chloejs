// The shop's own web server: one page with the chat box on it, and the one route
// that hands that page a pass. The token lives here and never reaches a page.
//
//   npx chloe tokens make "shop site" --agent shop    prints the token, once
//   CHLOE_TOKEN=chloe_... node server.ts
//
// Two addresses, because two different things reach the runtime. The page loads
// the box from BOX, which is public (the shop's proxy passes the web routes to
// the runtime and nothing else), and this server asks for passes at CHLOE,
// which is the runtime itself. On one machine, both are http://127.0.0.1:3067,
// and the channel's `origins` has to include http://localhost:8080.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

const BOX = "https://agent.myshop.com";
const CHLOE = "http://127.0.0.1:3067";
const AGENT = "shop";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>My shop</title>
<h1>My shop</h1>
<script src="${BOX}/api/web/chat.js" data-agent="${AGENT}" data-pass="/api/chat-pass" async></script>
`;

/**
 * The customer id of whoever sent this, from the shop's own sign-in, or nothing
 * for somebody not signed in. The shop's sessions go here. It is the only place
 * a customer id may come from: the agent's order tool shows that customer's
 * orders to whoever holds a pass made for them.
 */
function customerOf(request: IncomingMessage): string | undefined {
  return undefined;
}

/** An id for somebody not signed in, which can never be a customer's. */
const ANONYMOUS = /^anon-[0-9a-f-]{36}$/;

createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/chat-pass") {
    // A signed-in customer is their customer id. Anybody else gets a random id
    // in a cookie, so they find the same conversation tomorrow, and a cookie is
    // believed only when it holds one of those: whoever writes a customer's id
    // into it gets a new anonymous one instead, never that customer's orders.
    const kept = /(?:^|; )visitor=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "";
    const visitor = customerOf(request) ?? (ANONYMOUS.test(kept) ? kept : `anon-${randomUUID()}`);
    const asked = await fetch(`${CHLOE}/api/agents/${AGENT}/web/pass`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CHLOE_TOKEN}`, "content-type": "application/json" },
      // Whatever the agent should know about them: their name, their plan.
      body: JSON.stringify({ visitor, facts: {} }),
    });
    // Handed on as it came: the pass, when it runs out, and the agent's greeting.
    response.writeHead(asked.ok ? 200 : 502, {
      "content-type": "application/json",
      ...(ANONYMOUS.test(visitor) && { "set-cookie": `visitor=${visitor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` }),
    });
    return void response.end(await asked.text());
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
}).listen(8080, () => console.log("http://localhost:8080"));
