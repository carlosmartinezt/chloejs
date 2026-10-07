---
title: Models
order: 7
summary: A job picks its own model in one line, a person can pick one on the fly, and a call goes out by key or by subscription.
---

**A job can choose its own model, and that is the whole reason this runtime
exists.** One line, in the job:

```
model: "anthropic/claude-haiku-4.5"
```

No `model` means the agent's own, from its `agent.ts`, and an agent with no
`model` line asks `model.defaultModel` in settings, which is where `npx chloe setup`
writes the one you chose. So a project has that name in one place, and an agent
that names neither is refused as it loads rather than at its first model call.

Most jobs that still ask a model should ask a small one: the cheapest model that
can do the step is the right model for the step, and picking it per job is how
that stays true.

If you are ever tempted to move onto a framework, check that it can do this
first.

## Getting one

`npx chloe setup` asks which of these you have, writes it, and then makes one
real call and asks for a tool call back. That last part is worth more than it
sounds: a key with a character missing, a CLI nobody has signed in to, and a
model name that was retired last month all look exactly the same until something
asks.

**A subscription you already pay for.** A Claude subscription or a ChatGPT plan,
through the CLI that credential authorises, below. Nothing to paste and no key to
keep.

**A key of your own**, in `model.key`, against whatever `model.gatewayUrl` points at.
The key goes in `.env` as `CHLOE_MODEL_KEY` and the config hands it over as
`model: { key: process.env.CHLOE_MODEL_KEY }`.
One gateway for the whole machine, so if you might add a second provider later,
pick one that carries every provider rather than one provider's own address.

**Neither.** Free models need an account and no card: make a key at
[openrouter.ai/keys](https://openrouter.ai/keys), point `model.gatewayUrl` at
`https://openrouter.ai/api/v1/chat/completions`, and ask for `openrouter/free`,
which is one model id that picks a free model and only ones that can do what the
call needs, tool calling included. Three things to know before you build on it: a
free balance is rate limited to a few dozen calls a day, a different model may
answer each call, and free models report no price, so those runs cost 0 in the
record.

You can get a long way with no model at all. A job whose steps are all code runs
on any of this and costs nothing, which is why setup runs one of those before it
asks any of the above.

## A key or a subscription

A model call goes one of four ways. Everything above the one function that makes
the call is the same either way, which is why that function is the only seam.

```ts
settings: { model: { preferredRoute: ["claude", "codex", "opencode", "gateway"] } }
```

That is the default, and it is an order, not a choice. Each model goes by the
first way in the list that can carry its provider and that this machine is set up
for, so a subscription is spent before a key that charges per call, and the
gateway comes last because it is the only one that can carry any provider. A way
you have no credential for is skipped, so a fresh install runs whichever way that
machine can with nothing set.

**A subscription and an API key are two ways to the same model.** Nothing about a
model's name says which account pays for it. To put Anthropic and OpenAI models on
a key rather than on their subscriptions, put the gateway first:

```ts
settings: { model: { preferredRoute: ["gateway", "claude", "codex", "opencode"] } }
```

**gateway** is the plain one: one `fetch`, a model named
`anthropic/claude-sonnet-5`, and `model.gatewayUrl` points it at anything that
speaks the same shape, so another provider works without touching the code. It
needs `model.key`.

**claude** exists for the credential rather than the model. A subscription
authorises the Claude Code CLI and is not an API key, so there is nothing to put
in a bearer header and HTTP is not an option. It shells out to `claude -p` once
per step, with `--tools ""`, `--restricted` and `--strict-mcp-config`, so the CLI
brings none of its own tools, none of that machine's settings and no MCP servers.
Chloe still runs every tool itself, checks it against its schema and writes it
down, because a model that quietly read a file would leave nothing in the run
record. Only Anthropic models run this way.

**codex** is the same shape for OpenAI models on a ChatGPT plan: `codex exec`
once per step, in an empty temporary folder, with its shell, skills, browser,
MCP servers and AGENTS.md reading switched off and its instructions replaced by
the request's. It is a coding tool underneath, so every call carries about
7,000 tokens of its own instructions, and it names no price, so a run on it
costs 0 in the record. A ChatGPT plan allows only some models through it.

**opencode** is the third CLI, and the only one that is not one provider's. It
runs whatever opencode is signed in to, so chloe asks it (`opencode models`)
rather than being told, once per process. It is `opencode run` once per step, in
an empty temporary folder holding a config that names an agent with every tool
off and the request's own instructions. Two traps, both paid for: a config with a
`$schema` line makes it fetch that URL and hang, and it reads `PWD` rather than
asking where it is, so the folder has to be given as `--dir` too, because a
spawned process keeps its parent's `PWD` however its working folder was set. An
`--agent` it does not recognise is passed over in silence rather than refused, so
a tool call in the output means its own tools were in force, and chloe treats that
as an error rather than using the answer.

Two things to know before choosing a CLI route. The tools are described in the
prompt and asked for as JSON rather than through the provider's own tool
calling, which is a little less reliable and costs about 500 tokens of
instructions per step. And the cost on the run is what the call would have cost
on the API: a subscription is not billed per call, so that number prices the run
rather than charging it.

A job asking for a model its route cannot run says so rather than failing at
the provider.

## Picking one on the fly

The config is the default, and a pick on top of it lives in the database, so the
run record still says which model made each run. `model.models` in settings is a
shortlist, on top of what the agents already name, and only what that machine can
run is offered.

You do not have to write that list. Empty means chloe asks each way what it
carries: `opencode models`, and the gateway's own list, which is usually several
hundred. So the shortlist is for cutting that down to the few worth offering, not
for making the feature work.

In a chat, `/models` lists them, with a button each on Telegram. `/model <name>`
picks one for that chat, `/model <name> for everything` for the whole agent,
`/model <name> for <job>` for one job, and `/model default` takes a pick back,
with the same `for`. A pick for everything beats the agent's own model and
never a job's own: the job's line is the job's.

The same over the API: `GET /api/models` lists them and
`POST /api/agents/<id>/model` takes `{ "scope", "model" }`, where scope is
`agent`, `job:<id>` or `chat:<thread>` and an empty model takes the pick back.
