---
title: Models
order: 7
summary: Which model answers, how each call reaches it and who pays, every model setting, Auto, and picking one from a chat.
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
| A pick for one chat | `/model <name>`, or `/model auto`, in that chat (chat turns only) |
| The agent | `model` in `defineAgent`, or the quick model when it has `auto: true` (see Auto, below) |
| Every agent | `model.defaultModel` in settings, which `npx chloe setup` writes |

An agent with none of these is refused as it loads. A model given as an AI SDK
model, like `anthropic("claude-opus-5-5")`, always goes to that provider's own
API, on whatever key that package reads.

## How a call reaches it, and who pays

There are six routes. Each call goes by the first route in
`model.preferredRoute` that can carry the model's provider and is set up on this
machine. A route with nothing set up is skipped.

| Route | Goes through | Carries | Paid by | What to set up |
|---|---|---|---|---|
| `claude` | the `claude` command | Anthropic models | your Claude subscription | install Claude Code and sign in |
| `codex` | the `codex` command | the OpenAI models your plan allows | your ChatGPT plan | install Codex and sign in |
| `antigravity` | the `agy` command | Google models | your Google AI Pro plan | install Antigravity CLI and sign in with Google |
| `opencode` | the `opencode` command | whatever it is signed in to | that account | install opencode and sign in |
| `direct` | the provider's own API | Anthropic and OpenAI | your key, per call | `model.keys.anthropic`, `model.keys.openai` |
| `gateway` | an AI gateway | any provider it carries | its key, per call | `model.key` |

The default order is the one above, so a subscription is used before a key that
charges per call. To pay with a key instead, put `direct` first:
`model: { preferredRoute: ["direct", "claude", "codex", "antigravity", "opencode", "gateway"] }`,
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
| `model.preferredRoute` | `["claude", "codex", "antigravity", "opencode", "direct", "gateway"]` | The order routes are tried in. |
| `model.keys` | none | Anthropic's and OpenAI's own keys, for `direct`. |
| `model.key` | none | The gateway's key. |
| `model.gatewayUrl` | the Vercel AI Gateway | Any gateway that speaks the OpenAI chat shape. |
| `model.models` | ask each route | The shortlist a person may pick from in a chat. Empty offers everything this machine can reach, often hundreds: each command route and the gateway are asked what they run when chloe starts and when the config changes. |
| `model.program` | `claude`, `codex`, `agy`, `opencode` | Where each command is, when it is not on the path under that name. |
| `model.timeLimit` | `10` | The most minutes one model call may take, on any route. A call still going is stopped, its program killed, and the run fails saying so, instead of holding its job. 0 is no limit. A whole step and one tool call have a limit of their own: see [Step, model, agent](/docs/primitives). |
| `model.judgeModel` | `"anthropic/claude-sonnet-5"` | Who marks an eval. |
| `model.quickModel` | the route's own | What Auto hands an easy message, and who names a new conversation on the dashboard. Empty takes the quick model of the route the agent's own model goes by: the claude command's `haiku`, codex's `gpt-6-luna` while it lists it. The direct, gateway, antigravity and opencode routes have none, so name one here to use Auto on them. With none, the agent's own model names conversations. |

A call that fails in a way a fresh try might fix, such as the provider
cutting the stream or dropping the connection, is tried again twice, a few
seconds apart, before the run fails. So is an answer on the claude or
opencode route that writes tool calls out as text instead of making them. A refusal in words, a missing credential
and a usage limit fail at once. The direct and gateway routes also retry a
busy or failing provider four times within each call.

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

Each one runs the command once per step, with the command's own tools switched
off, so every tool call is chloe's and is written down.

- **claude** hands the tools over as real tools. It is never given
  `ANTHROPIC_API_KEY`, so a key in `.env` cannot quietly pay for a subscription
  run.
- **antigravity** describes the tools in the prompt too, like codex: the CLI
  refuses every tool of its own in headless mode, and real MCP tools are not
  used (the CLI reads its MCP servers from the account's own settings, which is
  the person's, not chloe's). The prompt goes in over stdin (`agy -p` hangs in a
  pipe), and a custom agent written into the run folder makes chloe's
  instructions the model's system prompt, which also keeps the CLI's own
  instructions out of the call (about 2k tokens a step, not 12k). The CLI still
  offers the model its own sixty tools and sometimes the model uses one, which
  headless refuses and which ends the turn, and its own call format is the same
  `{"tool": ...}` shape the prompt asks for: the route is not reliable yet.
- **opencode** hands the tools over as real tools too. For each step it starts
  an opencode server of its own, reachable from this machine only, and closes it
  after. It needs opencode 2 or later, and adds a second or two to each step.
  The conversation so far goes over as real past turns (opencode's
  `session/import`), so past calls are calls to the model and not text it might
  copy; only the newest turn is sent as the prompt. That endpoint is marked
  experimental, and an opencode without it gets the whole conversation as one
  block of text instead.
- **codex** describes the tools in the prompt and reads the calls back from the
  reply, which is a little less reliable and costs about 500 tokens a step. It
  adds about 7,000 tokens of its own instructions to every call.

A run on the claude route shows what it would have cost on the API, as a price,
not a charge. opencode names the price its own list gives the model: a charge
on an account that pays per call, only a price on a plan. codex and antigravity
name no price, so what their runs cost is unknown, and a `budget` or a web
chat's dollar limit cannot be kept on them.

## Auto

An agent with `auto: true` in `defineAgent`, or a chat picked onto it with
`/model auto`, asks the quick model about each message before it answers:
does this need the agent's own model? The quick model sees the message and
the last few in the conversation, never the agent's tools, and answers in a
line. An easy message is then answered by the quick model, and anything else
by the agent's own, in the same way as without Auto.

```ts
export default defineAgent({
  model: "anthropic/claude-opus-5-5",
  auto: true,
  identity: "Answers the shop's customers.",
});
```

- The quick model is found from the route the agent's own model goes by, so
  the same account pays for both: Opus through the claude command gets the
  command's Haiku. `model.quickModel` names one instead.
- A conversation that went to the agent's own model stays there for the hour,
  without asking again.
- When the quick model fails, or answers in words it cannot be read from, the
  agent's own model answers.
- The run's first line says which model it went to and why, and what asking
  cost is in the run's cost.
- Jobs are not on Auto: each keeps the model it names.

On a subscription, a quick model saves the plan's limits and time, not money.

## Picking one from a chat

`/models` lists what may be picked, with a button each on Telegram. A model
that more than one route here can run is listed once for each, the others as
`<name> via <route>`, and so it is on the dashboard.
`/model <name>` picks one for that chat, `/model <name> for <job>` for one job,
`/model auto` puts that chat on Auto, and `/model default` takes a pick back, with the same `for`. A pick is a trial
and is not how an agent's model is set: what it runs on is `model` in its own
definition, and there is no pick for the whole agent. The run record still says
which model made each run.

Over the API: `GET /api/models`, and `POST /api/agents/<id>/model` with
`{ "scope", "model" }`, where scope is `job:<id>` or `chat:<thread>`,
`"auto"` puts a chat on Auto, and an empty model takes the pick back.
