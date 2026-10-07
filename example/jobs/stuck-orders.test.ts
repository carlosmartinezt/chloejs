// The one rule in this job, checked without a database and without a model.
import { about, is } from "@chloejs/core/test";

import { stuck, GRACE_HOURS } from "./stuck-orders.ts";
import type { Order } from "../services/ordersService.ts";

about("which orders are worth chasing");

const now = Date.parse("2026-09-20T12:00:00Z");
const hours = (n: number) => new Date(now + n * 60 * 60 * 1000).toISOString();
const order = (extra: Partial<Order>): Order => ({
  id: "A-1", customer: "c-1", placed: hours(-200), paid: true, promised: hours(-48), total: 1000, lines: [], ...extra,
});

is("paid, unshipped and two days late is stuck", stuck(order({}), now), true);
is("the same order once it ships is not", stuck(order({ shipped: hours(-1) }), now), false);
is("an unpaid one is not ours to chase", stuck(order({ paid: false }), now), false);
is("one still inside the grace period is not yet late", stuck(order({ promised: hours(-GRACE_HOURS + 1) }), now), false);
is("and one due tomorrow is not late at all", stuck(order({ promised: hours(24) }), now), false);
