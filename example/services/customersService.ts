// The customer system: who they are, how they have been served, and what they
// have written in.
//
// Like `orders.ts`, the rows are held in memory so this agent runs with
// nothing installed. Point these functions at the real thing and the jobs do
// not change.

export interface Customer {
  id: string;
  name: string;
  /** When they first bought something. */
  since: string;
  /** Their last order, or missing if they have never ordered. */
  lastOrder?: string;
}

const CUSTOMERS: Customer[] = [
  { id: "c-91", name: "Halliday Coffee", since: "2024-02-11", lastOrder: "2026-09-16" },
  { id: "c-44", name: "Marchetti & Sons", since: "2023-08-30", lastOrder: "2026-09-15" },
  { id: "c-12", name: "The Corner Roastery", since: "2022-05-19", lastOrder: "2026-06-02" },
  { id: "c-30", name: "Ostrava Supplies", since: "2021-11-04", lastOrder: "2026-05-20" },
];

export async function customers(): Promise<Customer[]> {
  return CUSTOMERS;
}

export async function customer(id: string): Promise<Customer | undefined> {
  return CUSTOMERS.find((one) => one.id === id);
}

/** Customers who used to buy and have not ordered for this many days. */
export async function goneQuiet(days: number, now = Date.now()): Promise<Customer[]> {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return CUSTOMERS.filter((one) => one.lastOrder && Date.parse(one.lastOrder) < cutoff);
}

/** Something a customer wrote in, before anybody has read it. */
export interface Message {
  id: string;
  customer: string;
  at: string;
  text: string;
}

const MESSAGES: Message[] = [
  { id: "m-201", customer: "c-91", at: "2026-09-19T08:10:00Z", text: "Hi, order A-4417 was due Thursday and there's no tracking yet. We open Saturday and need the mugs by then." },
  { id: "m-202", customer: "c-44", at: "2026-09-19T09:55:00Z", text: "One of the two kettles turned up with a dent in the base. Photos attached. Can we get money back on that one?" },
  { id: "m-203", customer: "c-12", at: "2026-09-19T11:40:00Z", text: "Do you do a bigger bag than the 1kg? No rush, just planning ahead for the winter." },
  { id: "m-204", customer: "c-30", at: "2026-09-19T12:02:00Z", text: "Your invoice 8821 charges VAT twice. Please reissue before we can pay it." },
];

/** What has come in and not been handed to anybody yet. */
export async function unread(): Promise<Message[]> {
  return MESSAGES;
}

/** What one customer has written in, newest first. */
export async function messagesFrom(customer: string): Promise<Message[]> {
  return MESSAGES.filter((one) => one.customer === customer).sort((a, b) => b.at.localeCompare(a.at));
}

/** The desks a message can land on. A message goes to exactly one. */
export type Desk = "deliveries" | "returns" | "billing" | "sales";

/** Puts messages in one desk's queue. Returns how many it moved. */
export async function handTo(desk: Desk, ids: string[]): Promise<number> {
  console.log(`[${desk}] ${ids.join(", ")}`);
  return ids.length;
}
