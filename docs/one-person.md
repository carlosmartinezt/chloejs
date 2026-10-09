---
title: One person, and the people you invite
order: 11
summary: What belongs to the machine, what belongs to a person, and what someone you invite can see.
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
- **On a remote dashboard you can invite people** and give each one some
  agents, with the same switches as `dashboard.remote.allow`. Someone invited
  sees only the runs they started, without the prompts or the steps.

An agent folder is a role, not a person: one looks after the orders, one
answers customers. Who it works for is settings and `allowFrom`, so nothing in
an agent's folder should name anybody.
