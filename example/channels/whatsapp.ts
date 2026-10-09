// The shop's WhatsApp number, where customers write in. The number's id, a
// token and the app secret go in .env, and chloe.config.ts hands them over
// under `agents: { shop: { whatsapp: { ... } } }`. Without them the channel
// says so and does not start.
//
// Meta posts each message to a public address and has nothing to fetch one
// with, so the shop's web server passes /chloe/v1/shop/whatsapp on to chloe's
// port. The address to paste into the app is written to the log on start.
//
// Anybody may write, so no message is a turn with the agent's tools. Every one
// goes to answer-whatsapp-customer, which is code: it looks the number up
// first, and a number on no account is answered without asking a model. The job
// is named here and nowhere else, so nothing but a message on this number
// starts it. A channel for some people only lists their numbers in allowFrom,
// in full international form.
import { whatsappChannel } from "@chloejs/core/channels";

import answerWhatsappCustomer from "../jobs/answer-whatsapp-customer.ts";

export default whatsappChannel({ job: answerWhatsappCustomer });
