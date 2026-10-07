// What a customer means by what they wrote is a judgement, so it is a model
// step. Where each message then goes is a rule, so it is code.
//
// One call sorts everything that came in, so the price is per run and not per
// message, and the answer comes back in a shape the routing below can switch
// on. Nothing here reads the model's prose.
import { z } from "zod";

import { defineJob } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

import { handTo, unread, type Desk } from "../services/customersService.ts";

/** What a message is about. Every desk below is named by one of these. */
const About = z.enum(["late delivery", "damaged or wrong", "returns", "billing", "a question", "something else"]);

/** Which desk deals with which. A message lands on exactly one. */
const DESK: Record<z.infer<typeof About>, Desk> = {
  "late delivery": "deliveries",
  "damaged or wrong": "returns",
  returns: "returns",
  billing: "billing",
  "a question": "sales",
  "something else": "sales",
};

const Sorted = z.object({
  sorted: z.array(
    z.object({
      id: z.string().describe("The id of the message, copied exactly"),
      about: About,
      urgency: z.enum(["today", "this week", "whenever"]),
      wantsMoneyBack: z.boolean(),
      inAWord: z.string().max(60).describe("What they want, in a few words, for the queue"),
    }),
  ),
});

export default defineJob({
  id: "sort-messages",
  cron: every(15).minutes,
  timezone: "America/New_York",
  description: "Reads what customers wrote in and puts each one on the right desk.",
  model: "anthropic/claude-haiku-4.5",
  run: async (work) => {
    const waiting = await work.step("read what came in", () => unread());
    if (waiting.length === 0) return { sorted: 0, urgent: [], desks: {} as Record<string, number> };

    const read = await work.model("work out what each one is about", {
      instructions:
        "You sort a shop's inbox. Judge only what the customer wants, not what should be done about it. " +
        "Every message gets exactly one line back, with the id copied exactly.",
      output: Sorted,
      prompt: waiting.map((one) => `${one.id} (${one.at}): ${one.text}`).join("\n\n"),
    });

    // The rules, in code: where each one goes, and which are worth interrupting
    // somebody for. The model never decides either.
    const desks: Record<string, number> = {};
    for (const desk of new Set(read.sorted.map((one) => DESK[one.about]))) {
      const ids = read.sorted.filter((one) => DESK[one.about] === desk).map((one) => one.id);
      desks[desk] = await work.step(`hand ${ids.length} to ${desk}`, () => handTo(desk, ids));
    }

    const urgent = read.sorted.filter((one) => one.urgency === "today" || one.wantsMoneyBack);
    return { sorted: read.sorted.length, urgent: urgent.map((one) => `${one.id}: ${one.inAWord}`), desks };
  },
  response: (r) =>
    r.sorted === 0
      ? "nothing came in"
      : `${r.sorted} sorted into ${Object.keys(r.desks).length} desk(s)` +
        (r.urgent.length ? `, ${r.urgent.length} for today: ${r.urgent.join("; ")}` : ""),
});
