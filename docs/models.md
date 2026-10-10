---
title: Models
order: 7
summary: Which model answers, how each call reaches it and who pays, every model setting, and picking one from a chat.
---

A model is named as provider and name, `"anthropic/claude-sonnet-5"`. An agent,
a job or a single step can each name its own, so a cheap step can ask a small
model while the rest of the agent asks a large one.

## Which model answers

The first of these that is set wins.

| | Set with |
|---|---|
| One step | `model` on `work.model()` or `work.agent()` |
| A pick for one job | `/model <name> for <job>` in a chat |
| One job | `model` in `defineJob`, or in a markdown job's frontmatter |
| A pick for one chat | `/model <name>` in that chat (chat turns only) |
| A pick for the agent | `/model <name> for everything` |
| The agent | `model` in `defineAgent` |
| Every agent | `model.defaultModel` in settings, which `npx chloe setup` writes |

An agent with none of these is refused as it loads. A model given as an AI SDK
model, like `anthropic("claude-opus-5-5")`, always goes to that provider's own
API, on whatever key that package reads.

## How a call reaches it, and who pays

There are five routes. Each call goes by the first route in
`model.preferredRoute` that can carry the model's provider and is set up on this
machine. A route with nothing set up is skipped.

| Route | Goes through | Carries | Paid by | What to set up |
|---|---|---|---|---|
| `claude` | the `claude` command | Anthropic models | your Claude subscription | install Claude Code and sign in |
| `codex` | the `codex` command | the OpenAI models your plan allows | your ChatGPT plan | install Codex and sign in |
| `opencode` | the `opencode` command | whatever it is signed in to | that account | install opencode and sign in |
| `direct` | the provider's own API | Anthropic and OpenAI | your key, per call | `model.keys.anthropic`, `model.keys.openai` |
| `gateway` | an AI gateway | any provider it carries | its key, per call | `model.key` |

The default order is the one above, so a subscription is used before a key that
charges per call. To pay with a key instead, put `direct` first:
`model: { preferredRoute: ["direct", "claude", "codex", "opencode", "gateway"] }`,
which is what setup writes when you give it a key.

One model can go by another route than the order says by naming it at the end:
`"openai/gpt-5.5 via gateway"`. That works anywhere a model is named, in an
agent, a job or a pick from a chat, and the route is used even when it is not
set up, so the run fails saying what is missing rather than charging another
account.

A key is a secret, so it goes in `.env`, and the config hands it over:
`model: { keys: { anthropic: process.env.ANTHROPIC_API_KEY } }`, or
`model: { key: process.env.CHLOE_MODEL_KEY }` for a gateway.

| Setting | Default | What it controls |
|---|---|---|
| `model.defaultModel` | none | The model of an agent that names none. |
| `model.preferredRoute` | `["claude", "codex", "opencode", "direct", "gateway"]` | The order routes are tried in. |
| `model.keys` | none | Anthropic's and OpenAI's own keys, for `direct`. |
| `model.key` | none | The gateway's key. |
| `model.gatewayUrl` | the Vercel AI Gateway | Any gateway that speaks the OpenAI chat shape. |
| `model.models` | ask each route | The shortlist a person may pick from in a chat. Empty offers everything this machine can reach, often hundreds: each command route and the gateway are asked what they run when chloe starts and when the config changes. |
| `model.program` | `claude`, `codex`, `opencode` | Where each command is, when it is not on the path under that name. |
| `model.judgeModel` | `"anthropic/claude-sonnet-5"` | Who marks an eval. |
| `model.namingModel` | `"anthropic/claude-haiku-4.5"` | Who names a new conversation on the dashboard. Empty leaves them unnamed. |

### No model and no key yet

OpenRouter has free models with no card: make a key at
[openrouter.ai/keys](https://openrouter.ai/keys), set `model.gatewayUrl` to
`https://openrouter.ai/api/v1/chat/completions`, and ask for `openrouter/free`,
which picks a free model that can call tools. It is limited to a few dozen calls
a day, a different model may answer each time, and the runs cost 0 in the
record.

A job whose steps are all code needs no model at all, which is why setup runs
one before it asks for one.

### What the command routes do

Each one runs the command once per step, with the command's own tools, settings
and MCP servers switched off, so every tool call is chloe's and is written
down.

- **claude** hands the tools over as real tools. It is never given
  `ANTHROPIC_API_KEY`, so a key in `.env` cannot quietly pay for a subscription
  run.
- **codex** and **opencode** describe the tools in the prompt and read the calls
  back from the reply, which is a little less reliable and costs about 500
  tokens a step. codex adds about 7,000 tokens of its own instructions to every
  call.

A run on the claude route shows what it would have cost on the API, as a price,
not a charge. codex names no price, so its runs cost 0 in the record.

## Picking one from a chat

`/models` lists what may be picked, with a button each on Telegram. A model
that more than one route here can run is listed once for each, the others as
`<name> via <route>`, and so it is on the dashboard.
`/model <name>` picks one for that chat, `/model <name> for everything` for the
agent, `/model <name> for <job>` for one job, and `/model default` takes a pick
back, with the same `for`. The run record still says which model made each run.

Over the API: `GET /api/models`, and `POST /api/agents/<id>/model` with
`{ "scope", "model" }`, where scope is `agent`, `job:<id>` or `chat:<thread>`
and an empty model takes the pick back.
