// This agent on WhatsApp, through WhatsApp's own API. The number's id, a token
// and the app secret go in .env, and chloe.config.ts hands them over under
// `agents: { shop: { whatsapp: { ... } } }`. Without them the channel says so
// and does not start.
//
// Meta posts each message to an address and has nothing to fetch one with, so
// chloe keeps a post box somewhere else and collects from it. Nothing here is
// opened, and the address to paste into the app is written to the log on start.
//
// allowFrom is numbers in full international form, and an empty list answers
// the first message with the sender's number, which is what goes in it.
import { whatsappChannel } from "@chloejs/core/channels";

export default whatsappChannel({ allowFrom: [] });
