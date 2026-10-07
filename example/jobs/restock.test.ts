// The buying rule, checked without a supplier and without a model.
import { about, is } from "@chloejs/core/test";

import { toBuy, ORDER_DAYS, SPARE_DAYS } from "./restock.ts";
import type { Item } from "../services/stockService.ts";

about("how much to buy");

const item = (extra: Partial<Item>): Item => ({
  sku: "X", name: "A thing", onHand: 100, onOrder: 0, leadDays: 30, supplier: "Somebody", ...extra,
});

is("plenty of cover buys nothing", toBuy(item({ onHand: 1000 }), 1), 0);
is("what is already on the way counts as cover", toBuy(item({ onHand: 0, onOrder: 1000 }), 1), 0);
is("a slow shelf that nothing sells off buys nothing", toBuy(item({ onHand: 0 }), 0), 0);
is(
  "running short buys the lead time and the order period, less what there is",
  toBuy(item({ onHand: 10, onOrder: 5 }), 2),
  Math.ceil(2 * (30 + ORDER_DAYS)) - 15,
);
is("the spare days are what decides it is short", toBuy(item({ onHand: (30 + SPARE_DAYS) * 2, onOrder: 0 }), 2), 0);
