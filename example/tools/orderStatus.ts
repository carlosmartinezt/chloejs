// Where one of the customer's own orders is. The shop's site signs its
// customers in and asks for each chat's pass with their customer id as the
// visitor, so the runtime hands this tool who it is talking to, and the tool
// looks only at that customer's orders: a stranger who guesses an order number
// learns nothing. The order system is read through services/, the same as
// every job reads it.
import { tool } from "ai";
import { z } from "zod";

import { ordersBy } from "../services/ordersService.ts";

export const orderStatus = tool({
  title: "Looking up the order",
  description: "Where one of this customer's orders is: when it was placed, whether it has shipped, and the date they were promised. Takes the order number, like A-4417.",
  inputSchema: z.object({ id: z.string().describe("The order number, like A-4417.") }),
  execute: async ({ id }, { context }) => {
    // "web:<their customer id>", set by the runtime from the pass, never by the model.
    const user = (context as { user?: string } | undefined)?.user ?? "";
    if (!user.startsWith("web:")) return "Only a customer signed in on the shop's site can look up an order here.";
    const found = (await ordersBy(user.slice(4))).find((one) => one.id.toLowerCase() === id.trim().toLowerCase());
    if (!found) return `None of your orders is ${id}.`;
    return { id: found.id, placed: found.placed, paid: found.paid, shipped: found.shipped ?? "not yet", promised: found.promised };
  },
});
