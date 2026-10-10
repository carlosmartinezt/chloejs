---
title: Email
order: 6.04
under: channels
summary: Conversations by email, from an address made for each one, through Gmail, a mailbox with an app password, or a mailbox of your own: setting it up, which replies it takes, and every option.
---

The agent writes to a person from an address made for that conversation, and
their replies come back to it as messages. It is for conversations. To send one
email with no reply, use a [sending tool](/docs/tools#sending-an-email).

The agent always writes first, and only to somebody in `allowFrom`. A
conversation starts in one of three ways:

- a job asks with `work.ask("...", { who: "email:someone@example.com", ... })`;
- the agent calls the `email.startConversation` tool, from a chat;
- code calls `openEmail(agentId, to, subject, text)`.

## Which address it sends from

`mailbox` says which, and is required:

| | `mailbox: "gmail"` | `mailbox: "password"` | a mailbox of your own |
|---|---|---|---|
| The mail goes through | your Gmail or Google Workspace account | any mailbox an app password opens: Gmail, iCloud, Fastmail | whatever service you write it for |
| From | the agent's `label`, then the account in `connections.google.account`: `Shop <you@gmail.com>` | the agent's `label`, then `agents.<id>.email.address` | what your `send` does |
| Replies go to | the account with a tag, `you+k7mp2xqa@gmail.com`, set as Reply-To. Gmail delivers it to the same inbox. | the address with a tag, the same way | the address your `address` made |
| How chloe receives | asks Gmail what is new every 15 seconds | asks the mailbox's IMAP server (the one mail programs read from) every 15 seconds | your `receive` |
| What chloe reads | only mail to one of its tagged addresses | only mail to one of its tagged addresses, and nothing is marked read | only mail to an address it made |
| What you set | the Google connection, below | an address and an app password, below | the `Mailbox`, below |

With Google Workspace, the From address is on your own domain.

## Setting it up on Gmail

1. Make the Google app once, with the Gmail API on, as in
   [Connections](/docs/connections#google).
2. In `chloe.config.ts`, say which account sends, and hand over the app's client
   file:
   `connections: { google: { account: "you@gmail.com", client: process.env.CHLOE_CONNECTIONS_GOOGLE_CLIENT } }`.
3. Add the channel: `emailChannel({ mailbox: "gmail", allowFrom: ["someone@example.com"] })`.
4. Sign in. The agent's Connections page in the dashboard lists Google with a
   sign-in button. Approve reading and sending mail: chloe asks for
   `gmail.readonly` and `gmail.send`, and never deletes anything.
5. So the agent can start a conversation from a chat, give it the tool:
   `emailStartConversation: email.startConversation({ when: "..." })`, from
   `@chloejs/core/tools/email`.

| Option | Default | What it controls |
|---|---|---|
| `allowFrom` | required | The addresses it may write to and hear from. Nobody else is ever sent anything. |
| `mailbox` | required | `"gmail"`, `"password"`, or a `Mailbox` of your own. |
| `name` | `"email"` | Only when an agent has two. The first half of `email:<address>`. |

## Setting it up with an app password

No Google app and no sign-in page: an address and a password, like a mail
program on a phone. The provider must deliver mail sent to `you+tag@` to
`you@`. Gmail and Fastmail say so; iCloud does it without saying. Yahoo does
not, and Outlook.com no longer takes passwords from mail programs.

1. Make an app password in the provider's account settings: Gmail's needs
   2-Step Verification on first, iCloud's is under Sign-In and Security at
   account.apple.com, Fastmail's is under Privacy and Security.
2. Put it in `.env`, as `CHLOE_AGENTS_<ID>_EMAIL_PASSWORD`.
3. In `chloe.config.ts`:
   `agents: { <id>: { email: { address: "you@fastmail.com", password: process.env.CHLOE_AGENTS_<ID>_EMAIL_PASSWORD } } }`.
4. Add the channel: `emailChannel({ mailbox: "password", allowFrom: ["someone@example.com"] })`.

For Gmail, iCloud and Fastmail addresses chloe knows the servers. For any
other provider, add `imap` and `smtp` beside the password, each `"host:port"`
from the provider's help page: `imap: "imap.example.com:993"`,
`smtp: "smtp.example.com:587"`. The reading server is always TLS. A sending
server on 465 is TLS from the start; on any other port it must offer STARTTLS,
or nothing is sent, so the password never crosses in the clear.

Mail the agent sends is not copied to the Sent folder, except on Gmail, which
does that itself.

## A mailbox of your own

For mail through another service, `mailbox` is an object with three methods.
`Mailbox` and `OutgoingMail` are types from `@chloejs/core/channels`.

| Method | What it does |
|---|---|
| `address(person)` | Returns a new address for one conversation with that person. |
| `send(mail)` | Sends one `OutgoingMail`: `{ from, name, to, subject, text, html, inReplyTo?, references? }`. |
| `receive(take, signal)` | Hands each email that arrives to `take(to, raw)` until `signal` aborts. `raw` is the whole message, one character per byte (latin1). Forget a delivery only once `take` has finished, so a restart part way through an answer gets it again. |

The channel makes every check below itself, whichever mailbox it uses.

## Which replies it takes

A reply is answered only when every one of these holds. Anything else is
dropped, with a line in the log saying why.

- It is to an address this channel made, still open. An address closes after
  30 days with nothing sent or received on it.
- It has one From address, the person the address was made for, and they are
  in `allowFrom`.
- It carries a DKIM signature from that person's own mail domain. The From line
  alone can be written by anybody, so this is the check that counts.

Only what the person wrote this time is read, not the quoted history below it.
Attachments are named to the agent, not handed over.

