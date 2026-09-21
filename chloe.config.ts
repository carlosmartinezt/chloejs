// The agents the runtime's tests load in this repo. Not published.
import { defineConfig } from "chloejs";

import test from "./test-agent/agent.ts";

export default defineConfig({ agents: [test] });
