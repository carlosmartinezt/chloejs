// The order system, and the warehouse that packs what it says.
//
// Everything here is a stand-in: the rows are held in memory so this agent
// runs with nothing installed and no credentials. A real shop replaces the
// bodies of these functions with its own database or API, and not one line of
// any job in `jobs/` changes, because a job only ever reaches the shop
// through this file.

/** One order, as the shop's own system holds it. */
export interface Order {
  id: string;
  customer: string;
  /** When it was placed. */
  placed: string;
  paid: boolean;
  /** When it left the warehouse, or missing if it has not. */
  shipped?: string;
  /** The date the customer was given at the checkout. */
  promised: string;
  /** The total, in cents, so nothing here is ever a fraction. */
  total: number;
  lines: { sku: string; quantity: number }[];
}

/** Money for a person to read: 128940 is "1,289.40". */
export function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
}

const ORDERS: Order[] = [
  { id: "A-4417", customer: "c-91", placed: "2026-09-14T09:12:00Z", paid: true, promised: "2026-09-17T00:00:00Z", total: 8990, lines: [{ sku: "MUG-01", quantity: 2 }] },
  { id: "A-4418", customer: "c-44", placed: "2026-09-15T11:03:00Z", paid: true, shipped: "2026-09-16T08:40:00Z", promised: "2026-09-18T00:00:00Z", total: 24500, lines: [{ sku: "KET-02", quantity: 1 }] },
  { id: "A-4421", customer: "c-91", placed: "2026-09-16T16:55:00Z", paid: true, promised: "2026-09-19T00:00:00Z", total: 129900, lines: [{ sku: "GRD-11", quantity: 1 }, { sku: "BAG-03", quantity: 4 }] },
  { id: "A-4422", customer: "c-12", placed: "2026-09-17T07:20:00Z", paid: false, promised: "2026-09-22T00:00:00Z", total: 4500, lines: [{ sku: "BAG-03", quantity: 1 }] },
];

/** Every order the shop has taken. */
export async function orders(): Promise<Order[]> {
  return ORDERS;
}

/** Gives back part or all of what one order cost. Returns what was refunded, in cents. */
export async function refundOrder(id: string, amount: number): Promise<number> {
  const found = ORDERS.find((one) => one.id === id);
  if (!found) throw new Error(`There is no order called ${id}.`);
  if (amount > found.total) throw new Error(`${id} cost ${money(found.total)}, so ${money(amount)} cannot come back from it.`);
  return amount;
}

/** What one customer has ever bought, newest first. */
export async function ordersBy(customer: string): Promise<Order[]> {
  return ORDERS.filter((one) => one.customer === customer).sort((a, b) => b.placed.localeCompare(a.placed));
}

/** A refund somebody has asked for and nobody has decided on yet. */
export interface Refund {
  id: string;
  order: string;
  customer: string;
  asked: string;
  /** In cents, and never more than the order was. */
  amount: number;
  /** What the customer said when they asked. */
  because: string;
}

const REFUNDS: Refund[] = [
  { id: "r-7", order: "A-4418", customer: "c-44", asked: "2026-09-19T10:01:00Z", amount: 2450, because: "One of the two arrived chipped." },
  { id: "r-8", order: "A-4421", customer: "c-91", asked: "2026-09-19T14:30:00Z", amount: 129900, because: "Ordered the wrong model, unopened." },
];

/** Refunds asked for and not yet decided. */
export async function refundsAsked(): Promise<Refund[]> {
  return REFUNDS;
}

/** Pays one out. Returns what was paid, in cents. */
export async function payRefund(id: string): Promise<number> {
  const found = REFUNDS.find((one) => one.id === id);
  if (!found) throw new Error(`There is no refund called ${id}.`);
  return found.amount;
}

/** Puts a note in front of whoever packs the boxes. Returns how many it named. */
export async function tellTheWarehouse(subject: string, lines: string[]): Promise<number> {
  console.log(`[warehouse] ${subject}\n${lines.join("\n")}`);
  return lines.length;
}
