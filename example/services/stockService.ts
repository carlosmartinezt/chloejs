// The warehouse's own numbers, and the purchase orders sent to suppliers.
//
// Held in memory, like the other two, so this agent runs with nothing
// installed.

export interface Item {
  sku: string;
  name: string;
  /** On the shelf now. */
  onHand: number;
  /** Already bought and not yet arrived. */
  onOrder: number;
  /** Days between placing an order with the supplier and it landing. */
  leadDays: number;
  supplier: string;
}

const STOCK: Item[] = [
  { sku: "MUG-01", name: "Stoneware mug", onHand: 240, onOrder: 0, leadDays: 14, supplier: "Pentland Ceramics" },
  { sku: "KET-02", name: "Gooseneck kettle", onHand: 18, onOrder: 0, leadDays: 30, supplier: "Naoshima Metal" },
  { sku: "GRD-11", name: "Burr grinder", onHand: 6, onOrder: 12, leadDays: 45, supplier: "Naoshima Metal" },
  { sku: "BAG-03", name: "1kg bag, unbleached", onHand: 900, onOrder: 0, leadDays: 7, supplier: "Pentland Ceramics" },
];

export async function stock(): Promise<Item[]> {
  return STOCK;
}

/** How many of one item sold over the last so many days. */
export async function soldRecently(sku: string, days: number): Promise<number> {
  const aDay: Record<string, number> = { "MUG-01": 9, "KET-02": 1.4, "GRD-11": 0.6, "BAG-03": 22 };
  return Math.round((aDay[sku] ?? 0) * days);
}

/** Sends one purchase order and returns its number. */
export async function buy(supplier: string, lines: { sku: string; quantity: number }[]): Promise<string> {
  console.log(`[purchase order] ${supplier}: ${lines.map((one) => `${one.quantity} x ${one.sku}`).join(", ")}`);
  return `PO-${Math.floor(Date.now() / 1000)}`;
}
