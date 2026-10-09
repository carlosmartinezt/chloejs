import { z } from "zod";
import { defineAgent, defineJob } from "@chloejs/core";
import { deliverEmail } from "@chloejs/core/services";

const digest = defineJob({
  id: "digest",
  description: "A short morning note is in your inbox.",
  run: async (work) => {
    const { note } = await work.model("write the note", {
      prompt: "Write three upbeat lines to start the day.",
      output: z.object({ note: z.string() }),
    });
    await work.step("email it", () =>
      deliverEmail({ from: "Chloe <chloe@example.com>", to: ["you@example.com"] }, "Good morning", note),
    );
    return { note };
  },
});

const morning = defineAgent({
  id: "morning",
  description: "Sends a morning note.",
  instructions: "Be brief.",
  model: "anthropic/claude-sonnet-5",
  jobs: [digest],
});

const result = await morning.run({
  job: digest,
  settings: { connections: { resend: { api_key: process.env.RESEND_API_KEY } } },
});
console.log(result.text);
