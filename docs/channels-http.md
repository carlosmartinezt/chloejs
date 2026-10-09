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
start fresh. Without this channel a token gets a 403 for that agent, and only
somebody signed in on the dashboard can reach it. It takes `chatHistory` and
nothing else. A job that stops to ask somebody waits in `GET /api/parked`,
because HTTP cannot push a question out.

