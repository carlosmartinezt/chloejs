// A customer's message, answered with their own orders at hand. The shop's
// WhatsApp number (channels/whatsapp.ts) hands it every message, in place of a
// turn.
//
// Code goes first. The number they wrote from is looked up in the customer
// system, and a number on no account is answered without asking a model at
// all. Only then is one model step given that customer's orders and their
// message, and asked for the reply.
import { z } from "zod";

import { defineJob } from "@chloejs/core";

import { customerByPhone } from "../services/customersService.ts";
import { ordersBy } from "../services/ordersService.ts";

export default defineJob({
  id: "answer-whatsapp-customer",
  description: "A customer who wrote on WhatsApp has an answer that knows their orders.",
  run: async (work) => {
    // Their id on the channel it came in on, which on WhatsApp is their number.
    const who = await work.step("look them up", () => customerByPhone(work.input.userId));
    if (!who) return "This number is not on any of our accounts. Write from the number you order with, and we will find you.";
    const orders = await work.step("their orders", () => ordersBy(who.id));
    const { reply } = await work.model("write the reply", {
      instructions:
        "You answer a shop's customer, briefly and warmly, from their orders alone. " +
        "When the answer is not in them, say somebody from the shop will get back to them today.",
      output: z.object({ reply: z.string().min(1).max(1000) }),
      prompt: `${who.name} wrote: ${work.input.text}\n\nTheir orders: ${JSON.stringify(orders)}`,
    });
    return reply;
  },
});
