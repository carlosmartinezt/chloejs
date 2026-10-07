import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineAgent, defineJob, startChloe } from "@chloejs/core";
import { telegramChannel } from "@chloejs/core/channels";
import { every } from "@chloejs/core/timer";

const FOLDER = "/home/you/Downloads";
const MONTH = 30 * 24 * 60 * 60 * 1000;

const tidy = defineJob({
  id: "tidy",
  description: "Clears out downloads older than a month, once you say yes.",
  cron: every.sunday.at("10:00"),
  run: async (work) => {
    const old = await work.step("find old files", async () => {
      const found: string[] = [];
      for (const name of await readdir(FOLDER)) {
        if ((await stat(join(FOLDER, name))).mtimeMs < Date.now() - MONTH) found.push(name);
      }
      return found;
    });
    if (old.length === 0) return { deleted: 0 };

    const yes = await work.ask("ok to delete?", {
      question: `Delete ${old.length} old files from Downloads?\n\n${old.slice(0, 10).join("\n")}`,
      answer: z.boolean(),
      within: "1d",
      otherwise: false,
    });
    if (!yes) return { deleted: 0 };

    await work.step("delete them", () => Promise.all(old.map((name) => rm(join(FOLDER, name), { recursive: true }))));
    return { deleted: old.length };
  },
});

const housekeeper = defineAgent({
  id: "housekeeper",
  description: "Keeps the Downloads folder tidy.",
  instructions: "Be brief.",
  model: "anthropic/claude-haiku-4.5",
  jobs: [tidy],
  channels: [telegramChannel({ allowFrom: [123456789] })],
});

await startChloe({
  agents: [housekeeper],
  settings: { agents: { housekeeper: { telegram: process.env.TELEGRAM_TOKEN } } },
});
