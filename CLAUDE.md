# CLAUDE.md — chloejs

This is a system for running agents, not a framework that runs them for you.
Every change should leave it more like a system and less like a pile of
one-offs, and that is the test to apply when you are unsure.

Read `README.md` for what it is and `CONTRIBUTING.md` before you send anything.
This file is how to work in here.

Two files to read first, and which one depends on what you are doing:

- `core/steps.ts` runs a **job**: code, with a model as one step inside it
  when a step needs judgement. This is where most work belongs.
- `core/turn.ts` runs a **prompt**: ask a model, run the tools it asked
  for, ask again. This is for the open ended jobs only.

This repo is the runtime, and the package is the whole of it: what is at the
top is what is published, less `test-agent/` and `chloe.config.ts`, which are
here so the runtime's own tests have an agent to load.

Three other repos sit beside this one, and none of them is in it:
`chloejs-ui` (`~/chloejs-ui`) is the dashboard, a package the runtime works
without and never names. `chloejs-site` (`~/chloejs-site`) is chloejs.org: the
written docs, the examples, and a reference read out of this source on every
build, so a doc comment here is what the site says and a renamed export that a
doc quotes fails that site's next build. A push to `main` here rebuilds it.
The example agent, a small shop's back office that the docs quote, lives there
too, under `example/`, and its `do/` folder stands in for the order, customer
and stock systems, which is why it runs with nothing installed. `automations`
(`~/automations`) is one person's agents, running on this.

## What it is trying to be

**Code first.** Call it 95 and 5. This is not an agent that does things: it is
a job runner where asking a model is one kind of step, next to running a
command, reading a file and sending an email. The point is that you can always
say which 5, because the file says so and the run record prices it. A step that
asks is named in the file, it answers in a shape rather than in free text, and
it shows up as a line with a cost on it. If you cannot point at the line, it
does not happen.

**Shareable.** Someone should be able to install this, set one line in
`settings.local.json`, and have it run. Nothing in the runtime names a person, a
home directory or a machine. An agent is somebody's own, so a folder outside
the repo that it uses is a full path written in the agent file that uses it,
like `const BACKUPS = "/home/you/backups"` in the job that uses it.

Setting chloe up is filling in one file. Settings are JSON in
`settings.json` (in source control) and `settings.local.json` (one machine
only, mode 600), with every default and its one-line explanation in the schema in
`core/settings.ts`. A credential, a chat id or anything else naming a
person goes in `settings.local.json`, in a section named for the service it
belongs to (`resend`, `google`). The one exception is a channel: its token is an environment variable like `TELEGRAM_BOT_TOKEN`, kept in
`.env` beside the repo (which `server.ts` loads), or `credentials` in
the channel file. An environment variable still beats both settings files,
which is for a one-off run and for the tests, not for keeping a setting in.

**Plug and play.** Adding a capability should be writing a file and naming it
in the agent's `agent.ts`, not editing four. `agent.ts` imports every part of
the agent (instructions, jobs, tools, channels), so it is the one place that
says what the agent is, and `chloe.config.ts` at the top of the repo lists the
agents. Nothing is found by looking in a folder, except that every markdown
file in an agent's `skills/` is read. There is no deploy, so an edit is live in under a second.

**Generic before specific.** Anything every agent needs is written once and
bound, never copied per agent. If you find yourself writing the same small file
into three folders, stop: that is the signal you are about to industrialise
boilerplate rather than build a system.

**Self-improving, within a boundary.** An agent can rewrite its own skills and
keep its own notes, so a run can leave the next one better informed. It cannot
write its own tools or scripts, because code an agent writes is code it then
runs as itself.

**Simple.** Fewer files, fewer references between them, fewer words. The most
common cause of something being too complicated is a thing written down in two
places.

## First: how much autonomy does this actually need?

Use deterministic code wherever you can. Give autonomy to a model only where the
task genuinely needs judgement, interpretation, or a sequence nobody can write
down in advance.

Three primitives, and you reach down this list, not up it. Every rung costs more
money, takes longer, and can come back different tomorrow than it did today.

1. **`work.step()`, when you know what to do.** A query, a request, a
   calculation, a file, an email, a command. Ordinary TypeScript. This is where
   most work belongs.
2. **`work.model()`, when you know what to ask.** Code gathers the facts,
   `model(...)` hands them over with a zod schema for what must come back, code
   decides what to do with the answer. Classifying, extracting, summarising,
   ranking, writing the words.
3. **`work.agent()`, when you know only what you want.** A goal and a set of
   tools, for work whose order depends on what the last answer said. The model
   picks the order, inside the tools that step was handed, the calls `approve`
   lets through, and the limits `maxSteps` and `budget` put on turns and on
   spending.

And `work.ask()`, which is the opposite of autonomy: the job stops and a person
decides.

The test is which sentence is true. I know the operations and the order: `step`.
I know the question and the shape of the answer: `model`. I know the outcome and
the tools and nothing about the order: `agent`.

In chloejs-site, `example/jobs/restock.ts` is the shape to copy for the middle one: code works
out what to buy and buys it, and the one model step writes the line the buyer
reads. `example/jobs/why-they-left.ts` is the shape for the top one, and note
how little of that file is the agent step.

**An agent step is an escalation, not a default.** Two of them in one job, or one
that could have been three `step` calls and a `model`, is the thing to catch in
review. The model should get no more autonomy than the problem actually
requires, and the file should make it obvious which parts are deterministic,
which are a judgement, and which are autonomous.

## Then, for what is left: reach for these in order

These are for the parts that do stay a prompt.

1. **Words.** Change `instructions.md` or a skill. Most problems are a prompt
   problem, and this is live at once with no code.
2. **A skill and a script.** A markdown file saying when to do something, and a
   file in that agent's `scripts/` that does it. This is the normal way to give
   an agent a new capability.
3. **A tool.** Only when something must happen exactly the same way every time,
   or when it needs to be reachable with typed arguments.
4. **A tool in the runtime.** Only when two agents genuinely want the same
   thing, and then it goes in `model/tools/` as a function each agent
   binds, never as a tool they share.

Going straight to step 3 or 4 is the most common mistake made here.

## Where a file goes

`agents/` holds agents and nothing else: one folder per agent, each with an
`agent.ts`, and an agent runs only if `chloe.config.ts` lists it. An agent's
folder is the one its `agent.ts` is in, and could be anywhere. Its `name` is
what its run history and `data/<name>` are filed under, so it does not change;
`label` is what the page shows and can. Anything every
agent might want lives in the runtime instead, because there is one floor and not
two: `do/` is the work itself and `channels/` is how an agent is
reached. The rest is the runtime plus what a job commonly
needs, in folders by what they do: `model/` is asking a model, and
`model/tools/` inside it is the only thing a model can be handed,
`load/` is what an agent and a job
are, `timer/` is cron lines and `every()`, a library of its own that imports nothing else in the runtime, `serve/` is the one port
and what it answers with, which is `/api` and nothing else (the routes, the
login, and the folder behind the file tree): it serves no page, and an address
that is not an API call is a 404, `core/` is the floor (paths, running a command, staying
inside a folder, a small file an agent keeps, the database, frontmatter, words
in a markdown file, and the three runners), and `scorers/` is how a run
is marked. The runners in `core/` are the ones to read first:
`steps.ts`, `turn.ts` and `clock.ts` (what starts a job when its cron line is
due). They are the only files in `core/` that import anything else in
the runtime; the rest must not, and nothing there may know what an agent is
except those three. The two files left at the top are `server.ts` and `index.ts`, which is the
list of names `chloe` exports, and nothing is written in it.
A thing only one agent wants is not common, and lives in that agent's folder.
`agents/<name>/` is that agent's
own, including its `evals/`, which say what a good run of its jobs looks like.
`ops/` is the four things a person runs rather than the service: the
tests, the evals, `agent.ts`, which is talking to one agent and trying one
of its jobs without waiting for the cron line, and `account.ts`, which makes the
one account, because there is no setup page to make it on. A job lives in `jobs/` whether
it is code or a prompt, and whether or not it has a cron line: one folder.

The runtime is the floor everyone stands on, so nothing in it may name an agent
or a person, and nothing in `model/tools/` or `channels/` exports a
default: each exports a function that an agent binds.

**A tool is for a model and nothing else.** The work is a plain function in
`do/`, published from `"chloe"`, and a job calls it from a step.
`model/tools/` holds the wrappers over those functions, and a wrapper is
a description, a schema and one call. Nothing in it does work.

An agent's own folder is the same shape one level down: `agents/<name>/do/` is
what that agent does without asking, the address it sends from and the mail
search it is bound to, and `agents/<name>/tools/` is the wrappers. Nothing in
an agent's folder is found by looking, except `skills/`: a job, a tool or a
channel exists because `agent.ts` imports it. A job file in `jobs/` that its
agent does not name fails `npm run test`, because it would look like a job and
never run.

A job that imports a tool, chloe's or its own agent's, fails `npm run test`:
it either wanted a `do/` folder or it is paying a model to read a path it
already knew. The other direction is allowed: a tool may call a job's exported
function, because that is the work, and the tool is only the way a model
reaches it.

## Run this before you commit

```bash
npm run check
```

It type checks, then runs `ops/test.ts`. The rules in `README.md` are not
checked by anything any more, so they hold only as far as whoever is editing
holds them.

## Say whether the change helped

The two halves are checked differently, and reaching for the wrong one is a
waste of an afternoon.

```bash
npm run test         # the runtime and the jobs: does it do the thing
npm run evals <agent>  # the prompts: did the model decide well
```

Which model a call goes through is `model.via` in settings: the gateway, or the
Claude Code CLI on somebody's subscription. `MODEL_VIA=` in front of a command
changes it for one run.

`npm run test` runs jobs for real against an in-memory database and a stand-in
gateway on a loopback port, so it costs nothing and it either passes or it does
not. Code is tested, not scored. Moving a job down the hierarchy should grow this
and shrink the eval file.

Words are the other half, and they can only be scored. Words are the first
thing to reach for, and they are also the easiest thing to
make worse without noticing. An eval file in an agent's `evals/` folder is one
job of that agent's, with a case per situation: what every tool answers, and
what the agent should and should not have done about it. Run it before and
after you rewrite instructions or a skill. What a case may say is in
`ops/evals.ts`, which is the only thing that reads one.

Nothing in a case runs for real. A tool the case does not answer is refused,
not run, so an eval cannot restart a site or send an email. If you add a tool
to an agent, the cases will start failing with `TOOL_MOCK_NOT_DECLARED` until
the file answers it, which is the point.

## Things that will waste your time

**Work happens inside a step. Code outside a step only decides.** A job is an
async function, so to carry on after a pause it is run again from the top and
every finished step hands back what it returned last time. A `step` is written
down and never runs twice. A line outside one runs again on every resume, so if
it sends, writes or spends, it does so twice. This is the price of `if` and
`for` instead of a builder API, and it was worth paying, but it is the trap.

**A job that was edited under a parked run refuses to carry on.** The replay
checks the step's name as well as its place, because handing the wrong recorded
answer to the wrong step would look like it worked. The run stops and says the
job changed. That is the right answer: start it again.

**A `.ts` job has `run` or `markdown`, never both and never neither.** The
loader refuses the other two. `run` is code and `markdown` is a prompt, and
which one a job is is the most important thing about it.

**A model step answers in a shape or the run fails.** `model(...)` takes a zod
schema and validates against it, tells the model exactly what did not fit, and
tries once more. Free text never reaches the next step's control flow. If you
find yourself wanting the string, you wanted an agent step or a prompt.

**An agent step is recorded once, limits and all.** It is a step like any other,
so a run that parks and resumes does not live through the loop again. Reaching
`maxSteps` or `budget` is an error that says which, not a quiet half answer.
`approve` is asked before each call and a refusal goes back to the model as
words rather than stopping the step. Three things are refused outright: an agent
step with no tools (that is a model step in disguise), a budget that is not an
amount above zero, and an `ask` from inside any step, because a job pauses
between steps and not inside one.

**A parked run holds its job, and expires.** While a job waits on somebody
it does not start a second run, because that would ask the same
question twice. `within:` is how long it waits, `otherwise:` is what to carry
on with, and the clock sweeps for the ones nobody answered. An ask with neither
is a job that ends with "nobody answered", which is still an ending.

**An answer from a person is understood, not interpreted.** `ask` matches what
they typed against the schema, and "yes" against `z.boolean()` is a yes. No
model reads it. An answer that does not fit is asked again in plain words. Do
not add a model there: the whole point of stopping to ask was to take the
judgement out of the machine.

**Setting an environment variable at the top of a file does not beat an
import.** Imports are hoisted above it, so a module that reads the environment
as it loads reads the old value. `ops/test.ts` imports `core/db.ts`
by hand for exactly this reason, and the afternoon it did not, the tests wrote
into the real run history.

**A job's test sits beside the job, named `<job>.test.ts`.** The runner in
`ops/test.ts` runs its own cases and then loads every `*.test.ts` under
`agents/`, so a new one is a file and nothing else. Its cases come from
`test`, which is `about` and `is` and a count of what failed, shared so a
failing job fails `npm run test`. Anything about the runtime itself stays in
the runner: a test in `agents/` that does not name a job is in the wrong place.

**A tool cannot assume the process was started from the repo.** Paths come from
`core/paths.ts`, which finds the root by walking up for the folder that holds
`chloe.config.ts`, and an agent's folder is `agentDir(name)`, which is what
the agent declared. Scripts in `scripts/` are different: those run as real files with
their `cwd` set to that folder, and can use relative paths.

**An edit to the runtime needs a restart. An agent's own files do not.** The watcher
covers `chloe.config.ts` and each agent's folder, and on each reload every file
outside the runtime and `node_modules` is imported afresh (a hook in
`load/load.ts` gives each one a new query string), so a job's edit is
live though only `agent.ts` imports it. A change to the runtime itself, tools and channels included, needs
`systemctl --user restart chloe.service`.

**A markdown job takes four keys and no others**: `cron`, `description`, `timezone`,
`model`, all optional. Without `cron` a job runs only when somebody starts it,
and a `cron` that does not read stops the agent loading. It is named in
`agent.ts` as `markdownJob("jobs/<id>.md")`, and its file name is its id. Nothing refuses a fifth one right now, which is worth knowing: the
old system accepted a key it did not recognise by silently refusing to rebuild,
so the file looked saved, the service looked healthy, and the change never
happened. Teach `load/load.ts` to read a key before you write one.

**The runtime is a package: import it as `"chloejs"`, never by path.**
Inside this repo, `test-agent/` imports it by name too, which works because a
package can import itself. Six entrances and no others: `chloejs`,
`chloejs/tools` for a tool to bind, `chloejs/channels/<name>` for a channel to
bind, `chloejs/scorers` for marking a run, `chloejs/timer` for when a job runs
(`every`, and cron lines on their own), and `chloejs/test` for testing a job. Adding a name to
`index.ts` or `model/tools/index.ts` is publishing it, and taking one
away is a break, so anything not on those lists is free to move. Inside
the runtime the files reach each other by `#chloe/`, which `package.json`
maps, and `../` is the thing not to do.

**A job may be markdown or TypeScript, and a prompt is markdown either
way.** A `.md` beside a `.ts` of the same name is that job's words. A `.ts`
job has an `id`, which is what the run history is filed under, so it does not
change once the job has run, and the file is named after it. Paths given to
`prompt()` and `markdownJob()` are inside the agent's folder.

**A job can choose its own model, and that is the whole reason this
runtime exists.** One line, `model: "anthropic/claude-haiku-4.5"`, in the
frontmatter. If you are ever tempted to move onto a framework, check that it
can do this first.

**`timezone:` is real.** Daylight saving is handled through `Intl`, so write
`cron: every.day.at("07:00")` with `timezone: "America/New_York"` and stop doing UTC
arithmetic in a comment. The tests in `ops/test.ts` cover the mornings
the clocks change.

**A tool that fails does not kill the turn.** A missing tool, bad arguments, or
a tool that throws all go back to the model as text it can act on. This is
deliberate: a turn that dies on one bad call throws away everything it had
already done, and a model told what it got wrong usually fixes it next step.
So a run that "worked" may still contain failures: read the trace, not just the
reply.

**Two runs of the same job never overlap**, whether it is code or a
prompt, and the second is skipped rather than queued. A job that takes longer than its own interval will silently
run less often than its cron line says.

**A tool that reads someone's mail or notes is bound, not asked.** The search a
tool like `read_mail` runs comes from the agent's own binding, and the agent
chooses only how far back and how many. Reading one item re-runs that same
search and refuses anything that is not in it. A query an agent can write is a
filter, not a boundary: it widens the moment a turn goes wrong, and by then it
has already read the thing. If you add a tool that reaches private material,
give it this shape.

**An agent is on Telegram because its `agent.ts` lists
`telegramChannel({ allowFrom: [...] })` in `channels`**, imported from
`chloejs/channels/telegram`. `allowFrom` is Telegram
user ids, so an allowed person is answered in any chat, including a group made
later. One bot per agent, unless each has its own `name`. `mode` is `"polling"` (the default: chloe fetches
messages, nothing is exposed) or `"webhook"` (Telegram posts to
`/chloe/v1/<agent>/<channel name>`, which is answered before the login and checks its
secret on every call). Do not add another path past the login without a secret
and an allowlist of its own.

**An agent is reachable by another system because its `agent.ts` lists
`apiChannel()` in `channels`**, imported from `chloejs/channels/api`.
It listens to nothing. `POST /api/agents/<name>/chat` and
`POST /api/agents/<name>/job/<job>` are answered by `serve/http.ts`
either way, and what binding the channel does is let a **token** reach that
agent: without it a token gets a 403 and only the account can. It never carries
a question out, because HTTP cannot push, and a job that stops to ask still
waits in `GET /api/parked`.

**A job that is started by hand declares what it takes**, as `input`, a zod
schema, read back as `work.input`. It is checked before the run exists, so the
caller is told rather than handed a run id that fails later. A job with no
`input` takes nothing and refuses what it is sent rather than dropping it.
`state` moves and `input` does not, which is why there is no `setInput`.

**A channel starts a job with a fixed envelope**: `text`, `from`, `chat`,
`chatTitle`, `user`, `thread`, `replyTo`. One shape from every channel, so a
job written against it works from all of them. A message beginning with
`/<job id>` runs that job and nothing asks a model what was meant, because that
is a rule somebody can write down. Do not invent a second envelope for a new
channel.

**Every route is one entry in the list in `serve/http.ts`**, carrying its
own one-line description, and `GET /api` is generated from that list. Adding a
route means adding an entry, and a route with no description is a route that
does not compile. Do not answer a path anywhere else.

**Three kinds of caller, and the whole check is in one place** (`api()` in
`http.ts`): `open` is the four ways in, `token` is another system, and
everything else is the account. A token may read, and may chat to and fire the
jobs of the agents that bind an api channel. It may never write a file, read
the notes, or touch the tokens.

**The runtime serves its own site**, plain HTML from `serve/site.ts`, with
no build step and no dependencies. A build step here is the thing that site
exists to avoid. It is replaced wholesale by any installed package whose
`package.json` declares a `chloePage` folder, which is how `chloejs-ui` becomes
the dashboard. Nothing in the runtime names that package: `serve/page.ts`
looks for the declaration. If that folder has a `note-head.html`, its contents
go first in the head of every HTML file served from a memory, which is how the
page gives notes its components and its document style.

**Every agent has a memory**: the folder it reads and writes between runs.
`memory` in its definition, and unsaid it is the agent's own folder under the
state directory, which is where the memory tool has always written. It is worked
out once, by `memoryFolder()` in `load/load.ts`, and everything else reads that:
the memory tool, the site, and a job's `work.memory`. It was briefly a runtime
setting called notes, and that was wrong: whose folder it is, is the point.

**`serve/memory.ts` writes down every file it serves, before serving it.**
A read that could not be recorded is refused. That log is the only way to answer
afterwards what was taken through the port, and reading the same file from a
shell is deliberately not recorded: a shell is already the whole of the box.
Do not make that log best effort, and do not let the memory routes take a token.
Listing is recorded too: the names in a folder of personal writing say plenty
on their own. The log lives in `data/memory-audit/<agent>.jsonl`, outside the
memory it records, because for most agents the memory IS their state folder.

**A memory file is shown in a frame, sandboxed, and that is the whole of the
viewer's safety.** It is somebody's own HTML and it runs its own script, and it
may have been written by an agent from an email or a web page. Served as
`/memory/<pass>/<path>` with `sandbox allow-scripts` in its Content-Security-
Policy, it gets an origin of its own: its script runs, but it cannot reach the
page around it or call the API as the person signed in, and `connect-src 'none'`
stops it sending anything out. Without that, one crafted note is a script that
mints a token. **Never give the frame `allow-same-origin`, never drop the
`sandbox` from those headers, and never serve a memory file from a route that
takes the session cookie instead of a pass.** The pass (`serve/pass.ts`) exists
because a sandboxed document sends no cookie, so its own stylesheet needs another
way in: read one agent's memory, for ten minutes, and nothing else.

**A memory is a git repository only if its folder is the top of one.** Being
inside one is not enough: an agent's default memory is inside the repo its
definition is in, and asked from there git answers for that repo. A "commit all"
would stage every file in it and push would send them off the box.

**`confine()`'s never list (`.git`, `.ssh`, `secrets`, `node_modules`) is left
out of a listing, not just refused on open.** An agent's state folder is exactly
where its credentials live, and the first `secrets/` a tree met used to stop the
whole listing.

**`from()` in `login.ts` trusts only what a caller cannot write.**
`x-forwarded-for` is appended to by every hop, so the front of it is whatever
the client sent and the end is what the proxy in front actually saw. Read the
end. Reading the front lets a stranger pick which address gets locked out,
including somebody else's, and never be locked out himself.
`cf-connecting-ip` is preferred because Cloudflare overwrites it rather than
appending. Behind a CDN with neither, the lockout goes coarse, and coarse and
honest beats precise and forgeable. None of this is worth anything if something
other than the proxy can reach the port, which is why it binds loopback.

**A case is answered strictly.** A tool mock matches on the exact arguments, so
a case that answers `read_mail` with `{}` fails the moment the agent asks for
one message by id. Mark that answer `"anyArgs": true` when the arguments
do not change the answer, and `"times"` when one answer covers several calls.

**Do not assume a program is installed.** A tool that assumed `rg` was there
returned "nothing matched" for every search for weeks without anyone noticing. If a command might be missing, check for it and say so
rather than treating the failure as an empty result.

## What not to do

**Do not reach for a model because it is easier than writing the rules.** It is
easier, and that is the whole problem: it costs money every morning, it takes
seconds instead of milliseconds, and it can answer differently tomorrow. Before
adding a `model` step, say in one sentence what judgement it is making. If the
sentence is a rule, write the rule.

**Do not let a job ask a model twice without noticing.** Two model steps in one
job is two prices and two things that can drift. Sometimes it is right. It
should never be an accident, and the run record is where you catch it.

**Do not write facts about the world into a prompt.** Which sites exist, which
folders are in a notes tree, which services are broken: all of that goes stale
silently and then teaches the agent something untrue. If it can be read, read
it. If it genuinely has to be written down, put it where the agent rewrites it,
never where only a human edits it.

**Do not give an agent a power with nothing telling it when to use that
power.** Every script in an agent's `scripts/` folder is reachable by that
agent. If no skill or instruction mentions it, it does not belong there.

**Do not let the runtime learn an agent's name.** It is the floor everyone
stands on. Agent specific code lives in that agent's folder.

**Do not add a per-agent file for something every agent has.** Write it once
in `model/tools/` and let each agent name it in its `agent.ts`. What any
agent may want switched on (its notes tools, write_skill, run_script) is a
`features` flag in its definition instead, and the loader adds the tools.

**A channel says its own name, and nothing else may say it for it.** Every
`Channel` has a `name`, `channels` in a definition is a list, and the loader
refuses two with one name. `channels/telegram.ts` is allowed to know it is Telegram. Nothing outside
that file is: a job's question goes out to an address, `channel:who`, and
`model/ask.ts` looks the channel half up in a registry each running
channel fills for its own agent, so an agent's question goes out through its
own bot. The runtime still reaches somebody without knowing how, and an agent is
put on a channel by adding one entry to `channels` in its `agent.ts`.

A channel chloe does not ship is written in the agent's own `channels/` folder,
exporting a `Channel` with its own `name`, without editing anything in the runtime.

## House style

Plain words, short sentences. No jargon: if a word would need explaining on a
call, it is the wrong word, in prose and in code and in command names alike.
No em dashes, use a comma, colon, full stop or parentheses.

**Documentation is facts about the code.** Every comment, doc and README line
says what a function or file does, takes and returns, and what would surprise
someone using it. It never says what other product or framework the code
resembles or came from, never tells the story of how it got this way (that is
git's job), and never names anybody's accounts, bot names or handles: those
are read at run time or live in `settings.local.json`.

Comment only where the code cannot say it. A comment that explains a decision,
a trap, or something that cost someone an hour earns its place. One that
narrates the line below it does not, and neither does one that argues for the
code or admires it.

Keep them brief and factual. One or two lines, saying what is true, not why it
is good: "23:20 New York, before the site's quiet hours end" and not "Code, not
a prompt: a status code is not a judgement call, so nothing here asks a model."
The second kind reads as a defence of a choice nobody is arguing with, and it
goes stale the moment the choice changes.

A comment on a function is for someone calling it: what it does, what it
takes, and anything that would surprise them. It is not the story of the
change that produced it. "Whose they are is filled in when the agent loads, so
the name is not written twice" describes a refactor, and says nothing to
someone reading `memoryTools()` for the first time; "list_notes, read_notes,
search_notes and write_notes, all inside one folder" does. Words like
"now", "no longer", "used to" and "instead of" in a function's comment are the
sign. The history is in git.