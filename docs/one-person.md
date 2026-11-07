---
title: One person, and the people you invite
order: 11
summary: What belongs to the machine, what belongs to a person, what somebody you invite can see and do, and how they get a new password.
---

chloe is built for one person running their own agents. What that means today:

- **One way in** guards the dashboard on the machine: a link made from a shell
  there, or one password. Whoever has either can do everything.
- **Each channel's `allowFrom`** is who may reach an agent there. Nobody else
  is answered.
- **A key in the config belongs to the machine**, and every turn uses it:
  Resend, Brave, an MCP server's token.
- **An account somebody signs in to is theirs.** Google, and any connection of
  your own with a sign-in: your turns use yours, and anybody else signs in to
  their own the first time a tool needs it. Nobody is ever lent yours. The mailbox an
  email channel reads and sends from is the agent's, so it is always yours.
- **Every run has an owner**: whoever started it, or for a run the clock
  started, `owner` in settings, or else the first person in the agent's
  Telegram, Slack, Discord or WhatsApp `allowFrom`. A job's question goes to the owner
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

**A forgotten password.** On People, Password link next to them makes a link
that sets a new one, which you send them the same way. It works once, for a
day. If this copy can send mail (Resend set up, and `serve.url` set), they can
ask for one themselves instead: "Forgot password?" on the sign-in page mails it to
their address. The answer is the same whether or not the address is
somebody's, and one is mailed at most every ten minutes.

**Viewing as them.** Their conversations and runs are theirs, so they are not in
your list or your log. View as, next to them on People, shows you the page as
they see it for an hour: their rules, nothing that sends or changes anything,
and every read recorded. They can see the day you last did, and the invitation
says you can. Everything is still on your machine, so this keeps things apart
rather than secret.

**Sharing a conversation.** Share, at the top right of a chat, lets anybody
signed in to your page read that conversation by its link, whoever's it is and
whatever they were given, and nobody else write in it. Somebody you invited
can share theirs with you the same way. Stop sharing takes it back at once.
Somebody with no sign-in on your page cannot open it.

What they never get, whatever they were given: another agent, your
conversations or anybody else's unless one was shared with them, a memory, the agent's files or settings, a
model you did not list in `model.models`, tokens, People, or a change to anything. Taking them off their
last agent removes them and signs them out at once. An email conversation the
agent had with that same address is theirs too, since it was with them.

They reach the page the way you do, so somebody outside your network needs it
on a public name: see [From another machine](/docs/the-page#from-another-machine).
A person given chat gets every tool the agent has in their turns. A tool on an
account somebody signs in to reaches their own account, never yours; a tool on
a key in the config reaches what that key reaches, for them as for you. So
invite people to agents whose keyed tools are fine for them to use.

An agent folder is a role, not a person: one looks after the orders, one
answers customers. Who it works for is settings and `allowFrom`, so nothing in
an agent's folder should name anybody.
