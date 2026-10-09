// Who went quiet is arithmetic, so it is a step. Why one of them did is not a
// question with a known order in front of it: the answer might be in what they
// bought, in how late it arrived, or in what they wrote in and nobody
// answered, and which to look at next depends on what the last one said. That
// is the case for an agent step.
//
// What the job keeps is every limit around it: the three tools below are the
// whole of what it can reach, `toolApproval` says which of those calls may run,
// and `stopWhen` and `budget` say how far it may go before it has to stop.
import { isStepCount, tool } from "ai";
import { z } from "zod";

import { defineJob, note } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

import { goneQuiet, messagesFrom } from "../services/customersService.ts";
import { money, ordersBy } from "../services/ordersService.ts";

/** Days without an order before somebody counts as gone quiet. */
export const QUIET_DAYS = 90;

/** How many to look into in one run, so a bad Monday cannot cost a fortune. */
export const AT_MOST = 5;

/** What each look concluded, so the next run and the sales desk can read it. */
export const Findings = z
  .object({ found: z.array(z.object({ at: z.string(), customer: z.string(), why: z.string(), next: z.string() })) })
  .catch({ found: [] });

const Reason = z.object({
  why: z.string().describe("The most likely reason they stopped, in one sentence"),
  evidence: z.array(z.string()).min(1).describe("What you actually saw, one line each"),
  next: z.string().describe("The one thing a person should do about it"),
  worthACall: z.boolean(),
});

export default defineJob({
  id: "why-they-left",
  cron: every.monday.at("09:00"),
  timezone: "America/New_York",
  description: "Every good customer who stopped ordering has a reason and a next step.",
  run: async (work) => {
    const quiet = await work.step("find who went quiet", () => goneQuiet(QUIET_DAYS));
    if (quiet.length === 0) return { looked: 0, found: [] };

    const past = note(work.agentId, "why-they-left", Findings);
    const already = await work.step("read what was found before", () => past.read());

    const found: { at: string; customer: string; why: string; next: string }[] = [];
    for (const one of quiet.slice(0, AT_MOST)) {
      const theirs = ({ customer }: { customer: string }) =>
        customer === one.id ? "approved" : { type: "denied" as const, reason: `${one.id} is the customer being looked into, and ${customer} is not` };
      const reason = await work.agent(`work out why ${one.name} stopped ordering`, {
        prompt:
          `${one.name}, customer ${one.id}, has been buying since ${one.since} and last ordered on ` +
          `${one.lastOrder}. Work out the most likely reason they stopped, and what somebody here should do ` +
          `about it. Look things up in whatever order the answers suggest, and say what you actually saw.`,
        tools: {
          ordersTheyPlaced: tool({
            description: "Every order this customer has placed, newest first.",
            inputSchema: z.object({ customer: z.string().describe("The customer's id, like c-12") }),
            execute: async ({ customer }) =>
              (await ordersBy(customer)).map((order) => ({
                id: order.id,
                placed: order.placed,
                shipped: order.shipped ?? "never",
                promised: order.promised,
                total: money(order.total),
              })),
          }),
          whatTheyWroteIn: tool({
            description: "Messages this customer sent us, newest first.",
            inputSchema: z.object({ customer: z.string().describe("The customer's id, like c-12") }),
            execute: ({ customer }) => messagesFrom(customer),
          }),
          whatWasFoundBefore: tool({
            description: "What earlier runs concluded about this customer.",
            inputSchema: z.object({ customer: z.string().describe("The customer's id, like c-12") }),
            execute: ({ customer }) => already.found.filter((each) => each.customer === customer).slice(-3),
          }),
        },
        // The tools say what it may do. This says who it may do it to: the
        // model writes the arguments, so a limit on them is checked when it
        // asks rather than when the job is written. One customer's file is not
        // a reason to open everybody's.
        toolApproval: { ordersTheyPlaced: theirs, whatTheyWroteIn: theirs, whatWasFoundBefore: theirs },
        output: Reason,
        // Both limits, because eight turns of a large model is not a small
        // number. Whichever it reaches first ends the step with an error.
        stopWhen: isStepCount(8),
        budget: 0.05,
      });

      found.push({ at: new Date().toISOString(), customer: one.id, why: reason.why, next: reason.worthACall ? `call them: ${reason.next}` : reason.next });
    }

    await work.step("write down what was found", () => past.write({ found: [...already.found, ...found].slice(-50) }));

    return { looked: found.length, found: found.map((one) => `${one.customer}: ${one.why}`) };
  },
  response: (r) => (r.looked === 0 ? "nobody has gone quiet" : r.found.join(". ")),
});
