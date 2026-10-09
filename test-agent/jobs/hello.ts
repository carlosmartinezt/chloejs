import { defineJob } from "@chloejs/core";

export default defineJob({
  id: "hello",
  description: "Hello has been said.",
  run: async (work) => work.step("hello", () => "hello"),
});
