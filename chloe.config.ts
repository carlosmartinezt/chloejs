// The agents the runtime's tests load in this repo. Not published.
import { defineConfig } from "@chloejs/core";

import test from "./test-agent/agent.ts";

export default defineConfig({ agents: [test], settings: { model: { key: process.env.CHLOE_MODEL_KEY } } });
