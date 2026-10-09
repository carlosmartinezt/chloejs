// Paid for and still on the shelf. No model: "paid, not shipped, past the date
// we promised" is a rule, and a rule is code.
import { defineJob } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

import { money, orders, tellTheWarehouse, type Order } from "../services/ordersService.ts";

/** How long after the promised date an order is worth chasing. */
export const GRACE_HOURS = 12;

/**
 * An order somebody has paid for, that has not shipped, and that is now past
 * the date the customer was given plus the grace period.
 */
export function stuck(order: Order, now = Date.now()): boolean {
  if (!order.paid || order.shipped) return false;
  return now > Date.parse(order.promised) + GRACE_HOURS * 60 * 60 * 1000;
}

export default defineJob({
  id: "stuck-orders",
  cron: every(2).hours,
  timezone: "America/New_York",
  description: "The warehouse knows about every order that is paid for and late.",
  run: async (work) => {
    const all = await work.step("read the orders", () => orders());

    const late = all.filter((one) => stuck(one));
    if (late.length === 0) return { checked: all.length, late: [], worth: 0 };

    const worth = late.reduce((total, one) => total + one.total, 0);
    await work.step("tell the warehouse", () =>
      tellTheWarehouse(
        `${late.length} paid order${late.length === 1 ? "" : "s"} past the promised date`,
        late.map((one) => `${one.id}: promised ${one.promised.slice(0, 10)}, ${money(one.total)}, ${one.lines.length} line(s)`),
      ),
    );

    return { checked: all.length, late: late.map((one) => one.id), worth };
  },
  response: (r) =>
    r.late.length === 0
      ? `${r.checked} orders, none late`
      : `${r.late.length} late, ${money(r.worth)} sitting: ${r.late.join(", ")}`,
});
