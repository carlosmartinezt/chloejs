# Security

Report anything that looks like a way to read what it should not to
carlosmartinezt@gmail.com rather than in an issue.

Two things are worth knowing before you write a tool.

**A tool that reads private material is bound, not asked.** The mail search
behind `read_mail`, and the folder behind the notes tools, come from the agent's
own binding in its `agent.ts`. The model chooses only how far back and how many.
Reading one item re-runs that same search and refuses anything that is not in
it. A query a model can write is a filter and not a boundary: it widens the
moment a turn goes wrong, and by then it has already read the thing. Any new
tool that reaches private material should have this shape.

**An agent cannot write its own tools or scripts.** It can rewrite its own
skills and keep its own notes, because those are words. Code an agent writes is
code it then runs as itself.

The server binds loopback and everything on it but the login and a channel's own
path needs a session. Putting it on the internet means putting a login in front
of it: a reverse proxy with a password, and a webhook path exempt only if it
checks its own secret.
