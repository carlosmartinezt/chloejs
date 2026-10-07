// Talking to an agent's web channel from a page, with no look of its own. The
// chat box (chat.js) is built on this, and a page with its own design uses it
// straight:
//
//   import { chloeChat } from "https://agent.myshop.com/api/web/client.js";
//
//   const chat = chloeChat({
//     url: "https://agent.myshop.com",
//     agent: "shop",
//     pass: () => fetch("/api/chat-pass", { method: "POST" }).then((answer) => answer.json()),
//   });
//   const { greeting, messages } = await chat.history();
//   const { text } = await chat.send("Where is my order?", {
//     onText: (soFar) => show(soFar),           // the answer as it is written
//     onStep: ({ text }) => status(text),        // a tool it started: what it is doing
//     onSaid: (words) => add(words),             // words it wrote on the way
//   });
//
// `url` is where the runtime's /api is, through your own proxy or the cloud.
// `pass` asks your site's own server for a pass and returns it, as the pass or
// as `{ pass, expires }`: that server holds a token made for the agent and
// asks POST /api/agents/<id>/web/pass for the visitor. Without one there is no chat.
//
// Plain JavaScript in one file, with nothing to install and no build step.

/**
 * @param {{ url?: string, agent: string, pass: () => Promise<string | { pass: string, expires?: string, greeting?: string, pictures?: boolean }> }} options
 */
export function chloeChat({ url = "", agent, pass: ask }) {
  if (typeof ask !== "function") throw new Error("chloeChat needs pass: a function that asks your site's own server for one.");
  const base = `${url.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(agent)}/web`;
  /** @type {{ pass: string, expires: number, greeting?: string, pictures?: boolean } | null} */
  let held = null;

  /** A pass with more than a minute left, asked for when there is none. */
  async function pass() {
    if (held && held.expires - Date.now() > 60_000) return held.pass;
    const given = await ask();
    if (!given) throw new Error("The chat could not start.");
    const one = typeof given === "string" ? { pass: given } : given;
    held = { ...one, expires: one.expires ? Date.parse(one.expires) : Date.now() + 50 * 60_000 };
    return held.pass;
  }

  /** A call with the pass, asked for again once when the one held has run out. */
  async function call(path, init = {}, again = true) {
    const answer = await fetch(`${base}/${path}`, { ...init, headers: { ...init.headers, "x-chloe-pass": await pass() } });
    if (answer.status === 401 && again) {
      held = held && { ...held, expires: 0 };
      return call(path, init, false);
    }
    if (!answer.ok) {
      const body = await answer.json().catch(() => ({}));
      throw new Error(body.error || "That did not go through. Try again.");
    }
    return answer;
  }

  return {
    /** What the box shows before anybody writes, and whether it takes pictures, from the pass. */
    async start() {
      await pass();
      return { greeting: held?.greeting ?? "", pictures: Boolean(held?.pictures) };
    },

    /** This visitor's conversation so far, oldest first: `[{ role, text, at }]`, and the greeting. */
    async history() {
      return (await call("history")).json();
    },

    /** Forgets this visitor's conversation. */
    async clear() {
      await call("clear", { method: "POST" });
    },

    /**
     * One message, and the answer. `images` are `{ name, mediaType, data }`,
     * data being base64, on a channel that takes pictures. Resolves to
     * `{ text, runId }` once the answer is whole.
     *
     * @param {string} text
     * @param {{ images?: { name: string, mediaType: string, data: string }[], signal?: AbortSignal,
     *   onText?: (soFar: string, delta: string) => void, onStep?: (step: { tool: string, text: string }) => void,
     *   onSaid?: (words: string) => void }} [how]
     */
    async send(text, { images, signal, onText, onStep, onSaid } = {}) {
      const answer = await call("turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, ...(images?.length ? { images } : {}) }),
        signal,
      });
      let draft = "";
      let done = null;
      for await (const { event, data } of events(answer.body)) {
        if (event === "text") {
          draft += data.delta;
          onText?.(draft, data.delta);
        } else if (event === "said") {
          onSaid?.(data.text);
        } else if (event === "step") {
          // Words before a tool call were on the way, not the answer.
          if (draft) onSaid?.(draft);
          draft = "";
          onStep?.(data);
        } else if (event === "done") {
          done = data;
        } else if (event === "error") {
          throw new Error(data.message);
        }
      }
      if (!done) throw new Error("The answer stopped before it was finished. Try again.");
      return { text: done.text, runId: done.runId };
    },
  };
}

/** The events in a stream of them, each `{ event, data }`, data read as JSON. */
async function* events(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
    if (done) return;
  }
}
