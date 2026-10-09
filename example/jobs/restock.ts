// What to buy is arithmetic: how fast it sells, how long the supplier takes,
// how much is already on its way. The model is given none of that decision. It
// is given the numbers the code has already decided on and asked for the line
// the buyer reads with their coffee.
import { z } from "zod";

import { defineJob } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

import { buy, soldRecently, stock, type Item } from "../services/stockService.ts";

/** Days of cover to hold on top of the supplier's lead time. */
export const SPARE_DAYS = 14;

/** Days of sales one order is meant to cover. */
export const ORDER_DAYS = 60;

/**
 * How many to buy, given how many go out in a day. Zero means there is enough
 * on the shelf and on its way to last the supplier's lead time plus the spare.
 */
export function toBuy(item: Item, aDay: number): number {
  if (aDay <= 0) return 0;
  const cover = (item.onHand + item.onOrder) / aDay;
  if (cover >= item.leadDays + SPARE_DAYS) return 0;
  return Math.ceil(aDay * (item.leadDays + ORDER_DAYS) - item.onHand - item.onOrder);
}

export default defineJob({
  id: "restock",
  cron: every.monday.at("08:00"),
  timezone: "America/New_York",
  description: "Nothing is about to run out, and the buyer has one line on why each order was placed.",
  run: async (work) => {
    const items = await work.step("read the shelves", () => stock());
    const sold = await work.step("read what sold in 30 days", async () =>
      Object.fromEntries(await Promise.all(items.map(async (one) => [one.sku, await soldRecently(one.sku, 30)] as const))),
    );

    const short = items
      .map((item) => ({ item, aDay: sold[item.sku] / 30, quantity: toBuy(item, sold[item.sku] / 30) }))
      .filter((one) => one.quantity > 0);
    if (short.length === 0) return { bought: [], said: "", checked: items.length };

    // One purchase order per supplier, because that is how a supplier takes one.
    const bought: string[] = [];
    for (const supplier of new Set(short.map((one) => one.item.supplier))) {
      const lines = short.filter((one) => one.item.supplier === supplier).map((one) => ({ sku: one.item.sku, quantity: one.quantity }));
      const po = await work.step(`buy from ${supplier}`, () => buy(supplier, lines));
      bought.push(`${po}: ${lines.map((one) => `${one.quantity} x ${one.sku}`).join(", ")}`);
    }

    const said = await work.model("write the buyer's line", {
      instructions: "You write one or two plain sentences for the person who owns the buying. No greeting, no sign off.",
      output: z.object({ line: z.string().min(10).max(300) }),
      prompt: [
        "These were bought this morning, and nothing here is a decision you have to make:",
        ...short.map(
          (one) =>
            `- ${one.quantity} x ${one.item.name} (${one.item.sku}), selling ${one.aDay.toFixed(1)} a day, ` +
            `${one.item.onHand} on the shelf, ${one.item.onOrder} already on the way, ${one.item.leadDays} day lead`,
        ),
        "",
        "Say what changed and what to keep an eye on.",
      ].join("\n"),
    });

    return { bought, said: said.line, checked: items.length };
  },
  response: (r) => r.said || `${r.checked} lines, nothing to buy`,
});
