---
title: One person, for now
order: 11
summary: What is baked in for a single person, and the four changes that are cheap now and expensive later.
---

Nothing here is built for a team, and it is worth knowing where the seams are
before one arrives, because three of the four are cheap now and expensive later.

What is baked in today: one list of allowed users per Telegram bot or Slack app, one email
address, one account in front of the page, one `.env` with one key
per service, and a run record that does not say who any run was for.

The shape it should grow into is a chain: the channel establishes who is calling,
the run carries that person, their credentials are looked up for them, and the
tools run as them. A token either belongs to the agent or to a person. Jobs the
clock starts have no person attached, so they can only use the agent's own.

Four changes, in the order they are worth making:

1. **A run has an owner.** One column. Do it before there is a team, because
   everything else below reads it, and adding it later means a backfill and a
   guess.
2. **An ask names who.** Same reason. One person's approval resuming another
   person's job is the failure that does not announce itself.
3. **Secrets are keyed by person, with agent-owned as the stated exception.** A
   tool says which kind it wants, and a job the clock started asking for a
   person's token is a refusal rather than a fallback.
4. **The page shows you your runs.** One shared account becomes a login per
   person, and the history is filtered by owner. A run record holds whatever the
   jobs read, which can be somebody's calendar or their notes, so this one is not
   cosmetic.

And the rule that does not change: **an agent folder is a role, not a person.**
One looks after a box, one looks after a project, one answers messages. Who each
works for is settings. The floor everyone stands on names nobody, and an agent
folder should not name anybody either.
