---
title: One person, and the people you invite
order: 11
summary: What belongs to the machine, what belongs to a person, and what somebody you invite can see and do.
---

chloe is built for one person running their own agents. What that means today:

- **One way in** guards the dashboard on the machine: a link made from a shell
  there, or one password. Whoever has either can do everything.
- **Each channel's `allowFrom`** is who may reach an agent there. Nobody else
  is answered.
- **Every key belongs to the machine**, not to a person. A Gmail tool reads the
  account in settings, whoever asked.
- **Every run has an owner**: whoever started it, or for a run the clock
  started, `owner` in settings, or else the first person in the agent's
  Telegram, Slack or WhatsApp `allowFrom`. A job's question goes to the owner
  unless its `who` says otherwise.
- **You can invite people** to one agent or more, from People on the page.

## Inviting somebody

On the page, People, then Invite: their email, the agent, and what they may do
there.

| They may | Which means |
|---|---|
| chat | talk to the agent, in conversations of their own |
| read | see the runs they started, without the prompts or the steps |
| run | start the agent's jobs |

The page gives you a link, once. Send it to them yourself: chloe sends
nothing. It works once, for a week. Opening it, they choose a password, and
from then on they sign in on the same page with their email and that password.
Somebody already invited to another agent gives the password they have.

What they never get, whatever they were given: another agent, your
conversations or anybody else's, a memory, the agent's files or settings, a
model pick, tokens, People, or a change to anything. Taking them off their
last agent removes them and signs them out at once. An email conversation the
agent had with that same address is theirs too, since it was with them.

They reach the page the way you do, so somebody outside your network needs it
on a public name: see [From another machine](/docs/the-page#from-another-machine).
A person given chat gets every tool the agent has in their turns, so invite
people to agents whose tools are fine for them to use.

An agent folder is a role, not a person: one looks after the orders, one
answers customers. Who it works for is settings and `allowFrom`, so nothing in
an agent's folder should name anybody.
