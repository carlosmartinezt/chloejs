// Picking a model on the fly, and an answer cut short.

import { about, is } from "#chloe/ops/check";
import { agentFor, answers, codeJob, db } from "./shared.ts";

{
  about("a model on its provider's own key");
  const { viaKey } = await import("#chloe/model/key");
  const { settings } = await import("@chloejs/core");
  const keys = { ...settings.model.keys };
  Object.assign(settings.model.keys, { anthropic: "", openai: "" });
  const refusal = (model: string) => viaKey({ model, messages: [{ role: "user", content: "hi" }] }, "direct").then(() => "", (error: Error) => error.message);
  is("a provider with no key says where one goes", await refusal("openai/gpt-6-luna"),
    "No openai key. Put it in .env as CHLOE_MODEL_KEYS_OPENAI, and in chloe.config.ts's settings as `model: { keys: { openai: process.env.CHLOE_MODEL_KEYS_OPENAI } }`.");
  is("and one it has no place for says how else to reach it", (await refusal("deepseek/deepseek-chat")).startsWith("deepseek has no place in model.keys"), true);
  Object.assign(settings.model.keys, keys);
}

{
  about("a model picked on the fly");
  const { choices, choose, chosen, modelFor } = await import("#chloe/model/choices");
  const { commands, receive } = await import("#chloe/channels/shared");
  const { settings } = await import("@chloejs/core");
  const job = codeJob("nightly", async () => ({}));
  const agent = agentFor(job);
  const named = { ...job, model: "anthropic/claude-sonnet-5" };

  is("without a pick, the file decides", [modelFor(agent), modelFor(agent, job), modelFor(agent, named)], ["anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5"]);
  choose("test", "job:nightly", "openai/gpt-5.5");
  is("a pick for a job beats the job's own model, and the agent's", [modelFor(agent, job), modelFor(agent, named), modelFor(agent)], ["openai/gpt-5.5", "openai/gpt-5.5", "anthropic/claude-haiku-4.5"]);
  choose("test", "chat:test/api-pick", "openai/gpt-6-luna");
  is("every pick is listed, a job's before a chat's", choices("test").map((one) => `${one.scope}=${one.model}`), ["job:nightly=openai/gpt-5.5", "chat:test/api-pick=openai/gpt-6-luna"]);
  choose("test", "job:nightly", "");
  choose("test", "chat:test/api-pick", "");
  is("an empty model takes a pick back", [chosen("test", "job:nightly"), choices("test")], [undefined, []]);

  is("the menu ends with /models and /clear", commands(agent).slice(-2), [
    { command: "models", description: "Which model answers here, and the ones to pick from. The agent's own file decides it." },
    { command: "clear", description: "Start a new conversation" },
  ]);

  const listBefore = settings.model.models;
  settings.model.models = ["openai/gpt-6-luna"];
  const from = (text: string, thread = "test/api-pick") =>
    receive(agent, { channel: "api", chat: thread, thread, from: { id: "1", name: "me" }, text, private: true, fromOwner: true });
  try {
    const list = await from("/models");
    is("/models says what this chat uses and lists the rest", list?.text.split("\n").slice(0, 5), ["This chat: anthropic/claude-haiku-4.5 (the default)", "", "I can run:", "• openai/gpt-6-luna", "• anthropic/claude-haiku-4.5"]);
    is("with a button for each that sends the pick", list?.buttons?.map((one) => [one.label, one.sends]), [["openai/gpt-6-luna", "/model openai/gpt-6-luna"], ["anthropic/claude-haiku-4.5", "/model anthropic/claude-haiku-4.5"]]);
    is("/model picks for this chat", (await from("/model openai/gpt-6-luna"))?.text, "This chat now uses openai/gpt-6-luna.");
    answers.push("hello");
    await from("hi");
    const run = db.prepare("select model from runs where source = 'api' order by started desc limit 1").get() as { model: string };
    is("and the next turn in it goes there", run.model, "openai/gpt-6-luna");
    is("a chat on another thread does not", (await from("/models", "test/api-other"))?.text.split("\n")[0], "This chat: anthropic/claude-haiku-4.5 (the default)");
    is("a name that cannot be run is refused", (await from("/model nonsense"))?.text, "I cannot run nonsense. /models lists what I can.");
    is("nothing picks for the whole agent", (await from("/model openai/gpt-6-luna for everything"))?.text, "There is no pick for the whole agent: what it runs on is the model in its own definition.");
    is("and neither the agent nor its job moved", [modelFor(agent), modelFor(agent, job)], ["anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5"]);
    is("for a job picks for that job, with _ for -", (await from("/model anthropic/claude-haiku-4.5 for nightly"))?.text, "nightly now uses anthropic/claude-haiku-4.5.");
    is("and a job it does not have is said", (await from("/model openai/gpt-6-luna for weekly"))?.text, "I have no job called weekly. Mine: nightly.");
    is("/models then shows every pick that is not a chat's", (await from("/models"))?.text.split("\n").slice(0, 2), ["This chat: openai/gpt-6-luna", "nightly: anthropic/claude-haiku-4.5"]);
    is("default takes a chat's pick back", (await from("/model default"))?.text, "This chat is back on the default, anthropic/claude-haiku-4.5.");
    is("and says what a job is back on", (await from("/model default for nightly"))?.text, "nightly is back on the default, anthropic/claude-haiku-4.5.");
    is("a call with no conversation has nowhere to keep a pick", (await from("/model openai/gpt-6-luna", ""))?.text, "This call has no conversation to remember a pick for. Say for a job instead.");
    settings.model.models = ["openai/gpt-6-luna via gateway"];
    is("a model on a route of its own is picked whole, with for", (await from("/model openai/gpt-6-luna via gateway for nightly"))?.text, "nightly now uses openai/gpt-6-luna via gateway.");
    await from("/model default for nightly");
    // A token chats as itself and not as the owner, which is what the API says
    // with `fromOwner: false`. It may read the list and may change nothing.
    const asToken = (text: string) =>
      receive(agent, { channel: "api", chat: "test/api-token", thread: "test/api-token", from: { id: "1", name: "me" }, text, private: true, fromOwner: false });
    is("a token may read the list", ((await asToken("/models"))?.text ?? "").split("\n")[0], "This chat: anthropic/claude-haiku-4.5 (the default)");
    is("but may not pick for the chat", (await asToken("/model openai/gpt-6-luna"))?.text, "Only the owner picks the model.");
    is("nor pick for a job", (await asToken("/model openai/gpt-6-luna for nightly"))?.text, "Only the owner picks the model.");
    is("nor take a pick back", (await asToken("/model default"))?.text, "Only the owner picks the model.");
    is("and nothing was picked or taken back", [chosen("test", "job:nightly"), chosen("test", "chat:test/api-token")], [undefined, undefined]);
    choose("test", "chat:test/api-pick", "");
  } finally {
    settings.model.models = listBefore;
  }
}

{
  about("a streamed answer cut short");
  const { settings } = await import("#chloe/core/settings");
  const { ask } = await import("#chloe/model/model");
  const { gatewayUrl, startCounting } = await import("./shared.ts");
  const before = { ...settings.model };
  Object.assign(settings.model, { preferredRoute: ["gateway"], key: "test", gatewayUrl });
  try {
    const heard: string[] = [];
    const streaming = { model: "anthropic/claude-haiku-4.5", messages: [{ role: "user" as const, content: "hi" }], onText: (delta: string) => void heard.push(delta) };

    startCounting();
    answers.push({ content: "", cut: true }, "Five.");
    const again = await ask(streaming);
    is("one cut before any words is asked again", [again.text, heard.join(""), (await import("./shared.ts")).asked], ["Five.", "Five.", 2]);

    heard.length = 0;
    startCounting();
    answers.push({ content: "Twelve and more.", cut: true }, "Five.");
    const halfway = await ask(streaming).then(() => "", (error: Error) => error.constructor.name);
    is("one cut after words were handed on fails, so they are not said twice", [halfway, heard.join(""), (await import("./shared.ts")).asked], ["Error", "Twelve a", 1]);
    answers.length = 0;
  } finally {
    Object.assign(settings.model, before);
  }
}
