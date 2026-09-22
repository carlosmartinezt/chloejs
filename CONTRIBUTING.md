# Contributing

Run this before you send anything:

```sh
npm install
npm run check
```

That type checks and runs both suites. The tests run jobs for real against an
in-memory database and a stand-in gateway on a loopback port, so they cost
nothing and they either pass or they do not.

A few rules hold this place together, and a change that breaks one will be sent
back:

- **Nothing in the runtime names an agent, a person or a machine.** It is the floor
  everyone stands on.
- **A tool is for a model and nothing else.** The work is a plain function in
  `do/`, published from `@chloejs/core`, and a job calls it from a step. A tool
  is a description, a schema and one call over it.
- **Adding a name to `index.ts` or `model/tools/index.ts` is
  publishing it**, and taking one away is a break. Anything not on those lists
  is free to move.
- **Before adding a model step, say in one sentence what judgement it makes.**
  If the sentence is a rule, write the rule.
- **Plain words, short sentences, no jargon.** In prose, in code, and in command
  names alike. If a word would need explaining on a call, it is the wrong word.
- **Comments say what is true, not why it is good.** A comment that explains a
  trap, or something that cost somebody an hour, earns its place. One that
  narrates the line below it does not.

Bugs and questions: open an issue. A pull request that changes behaviour should
come with the test that would have caught it.
