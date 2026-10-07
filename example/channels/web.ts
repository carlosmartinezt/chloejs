// This agent in a chat box on the shop's own site, for the people who visit it.
// A visitor is a stranger, so their turn gets the one tool named here and
// nothing else the agent has: no notes, no jobs, no picking the model.
//
// The shop's own server holds a token made for this agent and gives each
// signed-in customer a pass from /api/chat-pass, with their customer id as the
// visitor, which is how orderStatus knows whose orders to look at. The page loads the box with one tag, from
// agent.myshop.com, which the shop's proxy sends on to this runtime:
//
//   <script src="https://agent.myshop.com/api/web/chat.js" data-agent="shop" data-pass="/api/chat-pass" async></script>
import { webChannel } from "@chloejs/core/channels";

export default webChannel({
  origins: ["https://myshop.com"],
  tools: ["orderStatus"],
  greeting: "Hi, I can tell you where an order is. What is its number?",
  limits: { perVisitor: { messages: 20, dollars: 0.25 }, perDay: { dollars: 3 } },
});
