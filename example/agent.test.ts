// That this agent is wired the way its agent.ts says. The runner finds this
// file because it is in the agent's folder, so there is nothing to register.
import { about, is } from "@chloejs/core/test";

import { load } from "@chloejs/core";

about("the shop agent, as it loads");

const shop = await load("shop");

is("it is reached the four ways its agent.ts names, and no other", shop.channels.map((one) => one.name), ["telegram", "whatsapp", "api", "web"]);
is(
  "its jobs are the ones it names",
  shop.jobs.map((one) => one.id).sort(),
  ["big-refunds", "how-it-went", "order-issues", "restock", "sort-messages", "stuck-orders", "why-they-left"],
);
is("one is a prompt and the rest are code", shop.jobs.filter((one) => !one.run).map((one) => one.id), ["how-it-went"]);
