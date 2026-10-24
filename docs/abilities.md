---
title: Abilities
order: 1.6
summary: The tools chloe brings to an agent: which ability adds each one, what it does, what is on by default, and the tools every agent has with no ability.
---

# Abilities

An ability is a set of tools chloe ships. Each is `true` or `false` in
`abilities` in the agent's `agent.ts`, with nothing to import:
`abilities: { memoryPerUser: true, scripts: true }`. Every tool chloe ships
has one, so anything built in can be switched on from the dashboard, which
writes the same line, says only what differs from the default, and puts the file
back with the reason when the agent would not load. A tool you write yourself,
and a connection's, is bound in `tools` instead ([Tools](/docs/tools)).

The tool names here are the ones the model sees. Your purpose and skills
should say what to do ("note it in your memory"), not name these tools, so a
rename breaks nothing ([A prompt with tools](/docs/prompts#skills-and-scripts)).

## The abilities

| Ability | Default | Tools it adds |
|---|---|---|
| `selfImprovement` | on | `selfWriteFile` |
| `memory` | on | `memoryListFiles`, `memoryReadFile`, `memorySearchFiles`, `memoryEditFile` |
| `scripts` | off | `scriptRun` |
| `memoryPerUser` | off | `memoryWriteUserNotes` |
| `folders` | off | `folderListFiles`, `folderReadFile`, `folderSearchFiles` |
| `web` | off | `webReadPage`, `webSearch` |
| `googleMail` | off | `emailReadMail`, `emailReplyMail`, `emailSendMail` |
| `googleCalendar` | off | `calendarListEvents`, `calendarAddEvent` |
| `googleDrive` | off | `driveSearchFiles`, `driveReadFile` |
| `resend` | off | `resendSendEmail` |

### memory

The agent's notes between runs, in its memory folder and nowhere else
([An agent](/docs/agents#memory) says where that is). `false` leaves them out.

| Tool | What it does |
|---|---|
| `memoryListFiles` | Lists the files in its memory. |
| `memoryReadFile` | Reads one. |
| `memorySearchFiles` | Finds the files that contain some text. The search is plain text, not by meaning. |
| `memoryEditFile` | Makes one or more changes to a file in one call, all or none. Each replaces one piece of text, which must be there once (the spaces at the start and end of its lines may differ). With no old text it adds to the end of the file, or makes the file. There is no tool that replaces a whole file, because that is how the rest of one gets lost. It also moves, renames or deletes a file or a folder, after any changes and in the same commit. |

Every run that changes the memory is one git commit under the agent's id.

### folders

Folders the agent may read and never change, like a project's code or the
docs of a product it answers questions about. They are yours, not its memory.
`paths` is the full path of each, and the model knows each by the last part of
its path, so no two may end the same; `about` is a few words for them.

`abilities: { folders: { paths: ["/home/you/shop", "/home/you/shop-site"], about: "the shop's code and its site" } }`

| Tool | What it does |
|---|---|
| `folderListFiles` | Lists a folder in one of them. The model is shown each one's layout, two levels down, at the start of each reply. |
| `folderReadFile` | Reads one file, or some of its lines. |
| `folderSearchFiles` | Finds some text in one of them, with the lines around each match. |

In a git repository, what git ignores is left out, so `.env.local`, `dist/`
and anything else in `.gitignore` is never listed, searched or read. A new file
git would add is seen at once. Any `.env`, `.git`, `secrets` and `node_modules`
is left out everywhere. A folder that is not there, or a path that is not full,
stops the agent loading. Somebody you invited gets these tools when you give
them chat; a guest on a web channel gets them only when the channel names
them.

### web

`webReadPage` reads one public web page as plain text, with links written as
`[text](url)`. It refuses this machine and private addresses, and does not run a
page's JavaScript. `webSearch` searches the web and gives back results, each a
title, a url and a line, which the model reads with `webReadPage`: it goes to
Brave Search when `connections.brave.api_key` is set, and to DuckDuckGo when it
is not. `web` is `true` for both; switch `webSearch` off on its own to read
pages only.

### resend

`resendSendEmail` sends one email through Resend to the addresses in `to`, from
`from`. The model writes only the subject and the body. `when` says when it
should send, in your words; `replyTo`, `tag`, `markdown` and `keep` are as in
[Tools](/docs/tools). Needs the Resend connection: a key in
`connections.resend.api_key`. Without one nothing is sent and nothing fails.

### googleMail, googleCalendar and googleDrive

Google, as three abilities that share the one sign-in (see
[Connections](/docs/connections#the-google-tools)). Each is `true` for its
narrowest reach, or its fields written out, which the Abilities page shows as a
form. The model never chooses what a field fixes. They are named for Google
because that is all chloe ships: another mail, calendar or drive is a tool you
bind yourself, or a mailbox of your own on the email channel.

| Ability | Fields | Tools |
|---|---|---|
| `googleMail` | `search` (a Gmail search, default `in:inbox`), `days` (7), `about`, `sendTo` (none), `sendFrom`, `sendWhen` | `emailReadMail`, `emailReplyMail`; with a `sendTo`, `emailSendMail`, which writes only the subject and the body |
| `googleCalendar` | `calendars` (`["primary"]`), `days` (7), `about` | `calendarListEvents`, `calendarAddEvent`, which invites nobody |
| `googleDrive` | `search` (all of Drive), `about` | `driveSearchFiles`, `driveReadFile` |

`abilities: { googleMail: { search: "label:orders", days: 3 } }`.
What an ability cannot hold (a copy folder for sent mail, several calendars to
add to, a limit worked out in code) is bound with the tool functions in `tools`,
which are on [Tools](/docs/tools). An email channel that may write first brings
`emailStartConversation` itself: see `start` in [Email](/docs/channels-email),
and a Telegram channel that may write first brings `telegramSendMessage`: see
`send` in [Telegram](/docs/channels-telegram).

### selfImprovement

`selfWriteFile` changes files in the agent's own folder: its purpose,
skills and jobs, and its code (`agent.ts`, tools, services, channels,
scripts). It writes every file one change needs in one call, and that is one
commit you can read and undo from the dashboard. With code among them, the
agent is loaded with the new files first, and if it would not load, every file
is put back and the agent is told why.

It is on by default, which suits an agent that is still being shaped. Switch it
off once the agent does what you want. It never writes its evals or its
memory. Code it writes runs with the same rights as chloe, so its folder
bounds what it writes, not what that code does.

It is in a turn only when the agent's owner asked, and is refused once another
tool in that reply read from outside the agent. The whole rule is
[What an agent may change about itself](/docs/prompts#what-an-agent-may-change-about-itself).

### memoryPerUser

`memoryWriteUserNotes` keeps one note on each person the agent talks to, on any
channel, as `users/<channel>-<id>.md` in its memory. The note is shown at the
top of each turn with that person, and the tool replaces it. Whose note it is
comes from who sent the message, never from the model, so one person on two
channels has two notes. A visitor on a [web channel](/docs/channels) gets this
tool even though the channel does not name it.

### scripts

`scriptRun` runs any file in the agent's `scripts/` folder, or any executable
file inside one of its skill folders (named `<skill>/<path>`), and returns what
it printed, or lists them. Each script must be executable (`chmod +x` and a
`#!` first line; one the agent writes itself with a `#!` is made so), runs
inside `scripts/` or its skill's folder, and gets the memory folder in
`MEMORY_FOLDER`. With this on and no script in either, the agent does not load.
Give each script a skill that says when to run it, or keep it in the skill's
folder. With it on, a file somebody sends is also saved for the scripts
([Skills and scripts](/docs/prompts#skills-and-scripts)).

## Switching one tool off

An ability is all of its tools. To keep an ability but not one of its tools, or
to switch off a tool you bound yourself without losing the options you gave it,
list its name in `without`: `without: ["memoryEditFile"]`. The dashboard writes
that list when you switch a single tool off: on the Abilities page for one an
ability adds, and on the Tools page for one you declared. A name that is no tool
of the agent stops it loading, saying what there is. An ability's tool may be
named while the ability is off.

On the Abilities page the group and its tools agree: with every one of an
ability's tools switched off, the ability reads off too, and switching it on
brings all of them back (its tools are taken out of `without`).

## With no ability

| Tool | Who gets it | What it does |
|---|---|---|
| `chatAsk` | every conversation | Ends the reply with a question and a few answers to pick from, one or several, shown as buttons where the channel has them. Their pick is their next message. [Asking a person](/docs/asking-a-person#from-a-chat). |
| `chatSendFile` | a conversation on a channel that can send files, never a guest's | Sends a file from its memory, or one it was sent, into that conversation. Telegram can. |
| `ownListFiles` | every turn | Lists the files in its own folder, and which it may change. Never its memory. |
| `ownReadFile` | every turn | Reads any of them, several in one call: its own source code and its skills included. The agent is shown every skill's description and the file to read, and reads the one it needs. |
| `ownListRuns` | turns its owner wrote | Lists its own runs, newest first: the job or chat, where it came from, when, the cost, and whether it failed. |
| `ownReadRun` | turns its owner wrote | Reads one run: what started it, the answer or the error, and each step on the way. |
| `ownTryJob` | turns its owner wrote | Runs one of its jobs as a [trial](/docs/jobs#a-trial-run), as its files are now: it reads for real, sends nothing, and answers with every message and email it would have sent. |
| `ownReadGuide` | turns its owner wrote | Reads these guides, several in one call, for the version installed, so it can say what it could be given (Gmail, a channel, web pages) and how. Its files and the list of guides are in its purpose in those turns, and an agent that may change itself is told to read what a change needs at once and never to ask for a secret in a chat. |

The owner is `owner` in settings, the first entry in a channel's `allowFrom`,
or the account on the dashboard. Reading its own folder is on for every turn,
but a job, a token and a visitor never get the tools that read its runs or try
its jobs, because a run holds what other people said. Reading a run, or trying
a job, counts as reading from outside, so a change after it in the same
conversation is refused.

## On a channel that names its tools

A channel's `tools` keeps a turn to the tools it names, plus the memory tools,
`ownListFiles` and `ownReadFile` (an agent may always read its own folder).
A visitor on a web channel is a guest and gets only what
the channel names, and `memoryWriteUserNotes` with `memoryPerUser` on. Naming a
memory or self tool there stops the agent from loading. See
[Channels](/docs/channels).
