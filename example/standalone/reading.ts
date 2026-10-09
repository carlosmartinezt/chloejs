import { isStepCount } from "ai";
import { z } from "zod";
import { defineAgent, defineJob } from "@chloejs/core";
import { deliverEmail } from "@chloejs/core/services";
import * as web from "@chloejs/core/tools/web";

const Picks = z.object({
  picks: z.array(z.object({ title: z.string(), url: z.string(), why: z.string() })).max(5),
});

const digest = defineJob({
  id: "reading",
  description: "The few things worth reading are in your inbox.",
  run: async (work) => {
    const { picks } = await work.agent("find what's worth reading", {
      prompt:
        "Start at https://news.ycombinator.com. Find up to five things a TypeScript developer " +
        "should read this week. Open the ones that look good before you pick them.",
      tools: { webReadPage: web.readPage() },
      output: Picks,
      stopWhen: isStepCount(15),
      budget: 0.25,
    });

    const body = picks.map((one) => `- [${one.title}](${one.url}): ${one.why}`).join("\n");
    await work.step("email it", () =>
      deliverEmail({ from: "Chloe <chloe@example.com>", to: ["you@example.com"], markdown: true }, "Worth reading", body),
    );
    return { picks: picks.length };
  },
});

const reader = defineAgent({
  id: "reader",
  description: "Reads the web so you don't have to.",
  instructions: "Pick less, not more. Say why in one line.",
  model: "anthropic/claude-sonnet-5",
  jobs: [digest],
});

const result = await reader.run({
  job: digest,
  settings: { connections: { resend: { api_key: process.env.RESEND_API_KEY } } },
});
console.log(result.text);
