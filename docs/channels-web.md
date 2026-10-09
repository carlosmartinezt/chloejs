---
title: A web page
order: 6.06
under: channels
summary: A chat box on your own site, talking to an agent: the pass your server hands out, what a visitor gets, the limits, and every option.
---

A chat box on your own site, talking to the same agent, with the same model and
run record. A visitor is a stranger, so they get only what you name.

1. Add the channel to the agent. It names the sites that may show the box and
   the tools a visitor's turn gets:

```ts file=example/channels/web.ts
```

2. Make a token for that agent alone. It lives on your site's server, never in
   a page, and is printed once:

```sh
npx chloe tokens make "shop site" --agent shop
```

3. Give your site one route that hands its page a pass, and put the box on the
   page. This is a whole site that does both, in plain Node. Who the visitor is
   (here, a signed-in customer's id) comes from your site's own sign-in, never
   from anything the visitor can write, because it decides what the agent's
   tools show them:

```ts file=example/site/server.ts
```

   In any framework it is the same route: `POST /api/agents/<id>/web/pass`
   with the token and `{ "visitor": "...", "facts": {...} }`. `facts` is
   whatever the agent should know about them: their name, their plan.

   To try it on one machine, set both addresses in it to
   `http://127.0.0.1:3067`, add `http://localhost:8080` to `origins`, run
   `npx chloe`, and open http://localhost:8080.

| Option | Default | What it controls |
|---|---|---|
| `origins` | required | The sites that may show the box, like `"https://myshop.com"`. |
| `tools` | none | The only tools a visitor's turn has. No memory, skills or self tools unless named, and naming the memory or self tools is refused. |
| `job` | none | A job every visitor's message goes to, instead of a turn. |
| `greeting` | none | What the box shows before anybody has written. |
| `limits` | 30 messages and $0.50 per visitor, $5 for everybody, per 24 hours | `{ perVisitor: { messages, dollars }, perDay: { dollars } }`. A turn past one is refused politely. |
| `model` | the agent's | The model visitors' turns use. |
| `pictures` | off | Whether a visitor may send pictures. |
| `chatHistory` | `{ messages: 10 }` | As on [every channel](/docs/channels#options-they-share). |

Besides `limits`, a visitor may send six messages a minute, of up to 4,000
characters each. A visitor never gets a `/command` but `/clear`, a model pick
or a sign-in.

**Reaching chloe.** It stays on loopback. Your own web server gives it an
address, here agent.myshop.com, and passes the box's routes and nothing else.
With Caddy:

```
agent.myshop.com {
    @web path_regexp ^/api/(agents/shop/web/(turn|history|clear)|web/(chat|client)\.js)$
    handle @web {
        reverse_proxy 127.0.0.1:3067 { flush_interval -1 }
    }
    respond 404
}
```

The pass route is not in it: your site's server reaches chloe directly.

**The box.** It sits in a corner, shows a tool's `title` while the agent works,
and writes the answer as it arrives. It keeps the conversation for the next
visit. Set `--chloe-accent`, `--chloe-font` and `--chloe-radius` on the page to
match your site, and `data-title`, `data-note`, `data-position="left"` and
`data-open` on the tag. For a look of your own, build on the client served
beside it:

```js
import { chloeChat } from "https://agent.myshop.com/api/web/client.js";

const chat = chloeChat({
  url: "https://agent.myshop.com",
  agent: "shop",
  pass: () => fetch("/api/chat-pass", { method: "POST" }).then((answer) => answer.json()),
});
const { messages } = await chat.history();
const { text } = await chat.send("Where is my order?", {
  onText: (soFar) => show(soFar),
  onStep: ({ text }) => status(text),
});
```

**What the agent knows about a visitor.** Each message reaches the model with
their id, the site, when they first came, how many messages before, their
country and browser, and your `facts`, never their IP address. With
`features: { memoryPerUser: true }` it keeps a note on each visitor.
`GET /api/agents/<id>/web/visitors` lists them.

**What you see.** Each visitor's conversation is in the agent's chat list,
marked web, and each turn is a run with its cost. A job asks a visitor with
`who: "web:<visitor>"`, and the question waits for the next time the box loads.

A pass is one agent, one site, one visitor, for an hour. Passes are signed with
`web-pass.key` in the state folder: delete it and restart, and every pass stops
working.

