// The agent the runtime's own tests load, so they have one to load in this
// repo. Not published. A real agent to copy from is the example on chloejs.org.
import { defineAgent } from "chloejs";

import hello from "./jobs/hello.ts";

export default defineAgent({
  name: "test",
  model: "anthropic/claude-haiku-4.5",
  description: "Loaded by the runtime's tests and nothing else.",
  instructions: "Answer in one line.",
  jobs: [hello],
});
