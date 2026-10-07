// The one agent this repo ships, and the one its docs quote: a small shop's
// back office, with a job at each level of autonomy. Orders that are late (no
// model at all), the inbox sorted (one model step), buying stock (code decides,
// a model writes the line), a customer's problem looked into (one of each, in
// one job), a customer who went quiet (an agent step), a refund big enough that a
// person decides, and one job that is a prompt from end to end.
//
// `services/` stands in for the systems a shop already has. Point those at the real
// thing and nothing in `jobs/` changes.
//
// Copy this folder, rename it, and put your own name in chloe.config.ts.
import { defineAgent, prompt } from "@chloejs/core";

import api from "./channels/api.ts";
import telegram from "./channels/telegram.ts";
import web from "./channels/web.ts";
import whatsapp from "./channels/whatsapp.ts";
import bigRefunds from "./jobs/big-refunds.ts";
import orderIssues from "./jobs/order-issues.ts";
import howItWent from "./jobs/how-it-went.ts";
import restock from "./jobs/restock.ts";
import sortMessages from "./jobs/sort-messages.ts";
import stuckOrders from "./jobs/stuck-orders.ts";
import whyTheyLeft from "./jobs/why-they-left.ts";
import { orderStatus } from "./tools/orderStatus.ts";

export default defineAgent({
  id: "shop",
  label: "Shop",
  // Any model the gateway or the CLI can reach. A job can name a different one
  // for itself, which is the point of choosing here rather than in the runtime.
  model: "anthropic/claude-sonnet-5",
  description: "Watches the orders, the inbox, the shelves and the customers who stopped buying.",
  instructions: prompt("instructions.md"),
  tools: { orderStatus },
  jobs: [stuckOrders, sortMessages, restock, orderIssues, whyTheyLeft, bigRefunds, howItWent],
  channels: [telegram, whatsapp, api, web],
});
