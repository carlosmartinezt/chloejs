// Small refunds are a rule, so they are paid without anybody being asked. A
// big one is somebody's money and somebody's call, so the job stops and asks a
// person. No model reads the answer: yes is yes.
import { z } from "zod";

import { defineJob } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

import { money, payRefund, refundsAsked } from "../services/ordersService.ts";

/** In cents. At or under this, a refund is paid without asking anybody. */
export const ON_SIGHT = 5000;

export default defineJob({
  id: "big-refunds",
  cron: every.weekday.at("09:30"),
  timezone: "America/New_York",
  description: "Pays small refunds, and asks a person about the ones worth asking about.",
  run: async (work) => {
    const waiting = await work.step("read the refunds asked for", () => refundsAsked());
    if (waiting.length === 0) return { paid: [], asked: 0, held: [] };

    const paid: string[] = [];
    for (const one of waiting.filter((each) => each.amount <= ON_SIGHT)) {
      const amount = await work.step(`refund ${one.id}`, () => payRefund(one.id));
      paid.push(`${one.id} (${money(amount)})`);
    }

    const held: string[] = [];
    const big = waiting.filter((one) => one.amount > ON_SIGHT);
    for (const one of big) {
      // Two days, because the question can sit until somebody is at a desk.
      // Nobody answering means the money stays where it is, which is the
      // answer that changes nothing.
      const yes = await work.ask(`refund ${money(one.amount)} to ${one.customer}?`, {
        question: `${one.customer} asked for ${money(one.amount)} back on ${one.order}: "${one.because}". Refund it?`,
        answer: z.boolean(),
        within: "2d",
        otherwise: false,
      });
      if (yes) {
        const amount = await work.step(`refund ${one.id}`, () => payRefund(one.id));
        paid.push(`${one.id} (${money(amount)})`);
      } else {
        held.push(one.id);
      }
    }

    return { paid, asked: big.length, held };
  },
  response: (r) =>
    [r.paid.length ? `paid ${r.paid.join(", ")}` : "nothing paid", r.asked ? `asked about ${r.asked}` : "", r.held.length ? `held ${r.held.join(", ")}` : ""]
      .filter(Boolean)
      .join(", "),
});
