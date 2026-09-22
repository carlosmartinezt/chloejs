// How a run is marked. Imported as "@chloejs/core/scorers", by whatever runs the
// evals: the tool calls a turn made, and what somebody said should have
// happened. Both name a type called Expected, so each keeps its own name.
export { calls, type Expected as ExpectedCalls, type Mark } from "./calls.ts";
export { expectations, type Expected as ExpectedOutcome } from "./expectations.ts";
