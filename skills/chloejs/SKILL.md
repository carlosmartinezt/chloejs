---
name: chloejs
description: Install Chloe (chloejs.org, the @chloejs/core TypeScript agent runtime) and build agents on it, with tools (Gmail, Calendar, Drive, web pages, files), chat channels (Slack, Telegram, WhatsApp, email, a chat box on a website) and scheduled jobs. Use when someone asks to install chloejs or Chloe, to make or change a Chloe agent, job, tool or channel, or works in a folder with a chloe.config.ts.
---

# Chloe

The guides ship inside the package and match the installed version, so this
skill only says how to get to them.

In a folder without Chloe:

```sh
npm init -y
npm install @chloejs/core
./node_modules/.bin/chloe setup
```

That runs the copy just installed and downloads nothing. Setup asks nothing
when there is no keyboard: it takes every default, writes the config with no agents, picks a free port and checks the model answers. The
first agent is yours to write, for what the person asked, from the guides
below. Give it an id that says what it does (`postie` for mail, `scout` for
research): it becomes its folder and the name its runs are kept under. Run
`npx chloe` only after the install, because without the package it fetches an
unrelated one.

To show the person their agents, start `npx chloe` in the background, leave it
running, and give them the link it prints. It opens the page signed in, with no
password to set. `npx chloe link` prints another.

Then, and in any project that already has a `chloe.config.ts`, read this before
writing code:

    node_modules/@chloejs/core/dist/docs/README.md

It lists every guide and what it covers. `npx chloe help` lists every command.
