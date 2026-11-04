---
title: HTTP
order: 6.05
under: channels
summary: Opening an agent to another system: one POST, one turn, one reply, with a token.
---

For another system rather than a person: one POST, one turn, one reply.

1. Add the channel to the agent:

```ts file=example/channels/api.ts
```

2. Make a token, with `npx chloe tokens make <name>` or on the dashboard's
   tokens page. The secret is shown once and not stored.
3. Call the agent:

```sh
curl -X POST http://127.0.0.1:3067/api/agents/shop/chat \
  -H "authorization: Bearer $CHLOE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt":"how many orders are late?"}'

{"runId":"...","text":"Three are late.","steps":2,"cost":0.0031}
```

```sh
curl -X POST http://127.0.0.1:3067/api/agents/shop/job/restock \
  -H "authorization: Bearer $CHLOE_TOKEN"

{"started":"shop/restock"}
```

Send `thread`, a name of your own, to carry on a conversation; leave it out to
start fresh. Send `timeZone`, the writer's, like "Europe/Madrid", for the model
to be told their date rather than the server's. A second message on a thread while its reply is going joins that
reply, and answers at once with `"joined": true` and no text: the first call's
reply answers both. `POST /api/agents/shop/chat/stop` with the same `thread`
stops the reply, and the first call answers `Stopped.` Without this channel a token gets a 403 for that agent, and only
somebody signed in on the dashboard can reach it. It takes `chatHistory` and
nothing else. A job that stops to ask somebody waits in `GET /api/parked`,
because HTTP cannot push a question out. A reply that asks them to pick carries
`buttons` and `multiple` ([Asking a person](/docs/asking-a-person#from-a-chat)).

A reply can take minutes, and that call stays open until it is done, which a
proxy in front of the server may cut off: Cloudflare gives up after 100 seconds
of silence. `POST /api/agents/shop/chat/start` takes the same body and answers
at once with `{"answer":"..."}`, and the reply goes on whatever happens to the
caller. `GET /api/agents/shop/chat/answers/<answer>` then says `{"going":true}`
until it is done, and after that what the chat call would have answered, or
`{"failed":"why"}`. A 404 means the answer is no longer held, because it came
over an hour ago or the service restarted: what was said is in the conversation.

