// Opting one agent in to being reached by another system.
//
//   // agents/<name>/channels/api.ts
//   import { apiChannel } from "chloejs/channels/api";
//   export default apiChannel();
//
// Binding it makes two routes answer for that agent when the caller holds a
// token, made at /tokens on the runtime site:
//
//   POST /api/agents/<name>/chat          one turn, and a reply
//   POST /api/agents/<name>/job/<job>     run one of its jobs now
//
//   curl -X POST http://127.0.0.1:3067/api/agents/shop/chat \
//     -H "authorization: Bearer $CHLOE_TOKEN" \
//     -H "content-type: application/json" \
//     -d '{"prompt":"how many orders are late?"}'
//
//   {"runId":"...","text":"Three.","steps":2,"cost":0.0031}
//
// `thread` is optional and is the caller's own name for a conversation: send
// the same one again and the agent remembers what was said. A token's threads
// are kept apart from the ones a person started.
//
// An agent without this channel is not on the API. Somebody signed in on the
// box can still talk to it from the site, because that is the account and the
// account can do everything. A token cannot, and gets a 403 saying so.
//
// Why this is a channel and not a flag: a channel is the thing an agent's
// definition already lists to say how it can be reached, and being reachable
// by another system belongs in that list beside telegram. It listens to
// nothing and starts nothing, because the server already answers those two
// routes. What this adds is the permission.
//
// It does not carry a job's question out to anybody, because HTTP cannot push.
// A job that stops to ask waits in GET /api/parked like it always did.
import type { Channel } from "#chloe/load/load.ts";

export function apiChannel(): Channel {
  return { start: () => ({ stop: () => {} }) };
}
