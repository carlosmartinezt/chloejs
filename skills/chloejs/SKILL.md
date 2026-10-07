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
npx chloe setup --agent <id>
```

Pick an `<id>` that says what the agent does (`postie` for mail, `scout` for
research): it becomes its folder and the name its runs are kept under. Setup
asks nothing when there is no keyboard: it takes every default, writes the
files, checks the model answers and runs a first job. Run `npx chloe` only
after the install, because without the package it fetches an unrelated one.

Then, and in any project that already has a `chloe.config.ts`, read this before
writing code:

    node_modules/@chloejs/core/dist/docs/README.md

It lists every guide and what it covers. `npx chloe help` lists every command.
