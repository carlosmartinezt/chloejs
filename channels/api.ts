// Opting one agent in to being reached by another system.
//
//   // agents/<id>/agent.ts
//   import { apiChannel } from "@chloejs/core/channels";
//   channels: [apiChannel()],
//
// Binding it makes two routes answer for that agent when the caller holds a
// token, made at /tokens on the runtime site:
//
//   POST /api/agents/<id>/chat          one turn, and a reply
//   POST /api/agents/<id>/job/<job>     run one of its jobs now
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
import type { Channel, ChatHistory } from "#chloe/load/load";

/**
 * Lets other programs reach the agent with a token. Add it to the `channels`
 * list in the agent's `agent.ts`:
 *
 * ```ts
 * channels: [apiChannel()],
 * ```
 *
 * A token can then call these two routes for this agent:
 *
 * - `POST /api/agents/<id>/chat`: send a message and get the reply. Send the
 *   same `thread` again to carry on a conversation.
 * - `POST /api/agents/<id>/job/<job>`: run one of its jobs now.
 *
 * Without this channel, a token gets a 403 for this agent. Somebody signed in
 * to the dashboard can still talk to it. Make tokens on the dashboard, or with
 * `npx chloe tokens make`.
 *
 * It cannot send a job's question to anybody, so a job that asks pauses and
 * waits, and shows in `GET /api/parked`.
 *
 * `options.chatHistory` is how much of the conversation the agent sees with
 * each new message: `{ messages, days }`. Default: the last 10 messages.
 */
export function apiChannel(options: { chatHistory?: ChatHistory } = {}): Channel {
  return { name: "api", chatHistory: options.chatHistory, start: () => ({ stop: () => {} }) };
}
