// The whole ladder in one job: code loads the inbox, a model says what each
// message is about, and an agent looks into the ones nobody can answer from the
// message alone. It can put things right with a refund, and a big one waits for
// a person to say yes.
import { isStepCount, tool } from "ai";
import { z } from "zod";

import { defineJob } from "@chloejs/core";
import { every } from "@chloejs/core/timer";

import { messagesFrom, unread } from "../services/customersService.ts";
import { money, ordersBy, refundOrder } from "../services/ordersService.ts";

const Issue = z.object({
  about: z.enum(["delivery", "damage", "billing", "a question"]),
  needsInvestigation: z.boolean(),
});

const getOrders = tool({
  description: "Every order this customer has placed, newest first.",
  inputSchema: z.object({ customer: z.string() }),
  execute: ({ customer }) => ordersBy(customer),
});

const pastMessages = tool({
  description: "Everything this customer has written in before, newest first.",
  inputSchema: z.object({ customer: z.string() }),
  execute: ({ customer }) => messagesFrom(customer),
});

/** In cents. Over this, a refund waits for a person. */
const ON_SIGHT = 5000;

const refund = tool({
  description: "Refund part or all of one order, in cents.",
  inputSchema: z.object({ order: z.string(), amount: z.number().int().min(1) }),
  needsApproval: ({ amount }) => amount > ON_SIGHT,
  execute: async ({ order, amount }) => `refunded ${money(await refundOrder(order, amount))} on ${order}`,
});

export default defineJob({
  id: "order-issues",
  cron: every(15).minutes,
  description: "Every customer message that needs looking into has been looked into.",
  run: async (work) => {
    const messages = await work.step("load messages", () => unread());

    const looked: string[] = [];
    for (const message of messages) {
      const issue = await work.model("classify issue", {
        prompt: message.text,
        output: Issue,
      });
      if (!issue.needsInvestigation) continue;

      const found = await work.agent("investigate issue", {
        prompt: `Find out what went wrong for customer ${message.customer}, and put it right if a refund will.`,
        tools: { getOrders, pastMessages, refund },
        stopWhen: isStepCount(6),
        budget: 0.05,
      });

      looked.push(`${message.id}: ${found}`);
    }

    return { looked };
  },
});
