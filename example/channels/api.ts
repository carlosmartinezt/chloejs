// This agent may be reached by another system holding a token.
//
// Without this file, POST /api/agents/shop/chat is refused for a token and
// answered only for somebody signed in on the box.
import { apiChannel } from "@chloejs/core/channels";

export default apiChannel();
