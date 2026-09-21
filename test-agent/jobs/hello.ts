import { defineJob } from "chloejs";

export default defineJob({
  id: "hello",
  description: "Says hello.",
  run: async (work) => work.step("hello", () => "hello"),
});
