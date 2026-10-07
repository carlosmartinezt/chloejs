// The chat box: a button in the corner of a page that opens a conversation with
// one agent's web channel. One tag on the page:
//
//   <script src="https://agent.myshop.com/api/web/chat.js" data-agent="shop" data-pass="/api/chat-pass" async></script>
//
// It talks to the runtime it was loaded from: the part of its own address
// before /api/web/chat.js. Through the cloud, data-agent is "<workspace>/<agent>".
//
//   data-pass       required: an address on your own site that answers a POST
//                   with a pass, `{ pass, expires }`. Your server asks the agent
//                   for it, with a token made for that agent.
//   data-url        where the runtime's /api is, when it is not where this came from
//   data-title      the heading on the box ("Chat")
//   data-note       the line under it ("An AI agent, run by <this site>")
//   data-position   "left" for the bottom left corner; the right otherwise
//   data-open       open as the page loads
//
// Its colours, font and corners follow three CSS variables a page can set:
// --chloe-accent, --chloe-font and --chloe-radius.
//
// Drawn in a shadow root, so the page's styles cannot reach in and its own
// cannot reach out. What the agent writes is shown as text: a link, a list and
// bold are drawn from the markdown, and nothing it writes becomes HTML.
(() => {
  const script = document.currentScript;
  if (!script) return;
  const source = new URL(script.src, location.href);
  const said = script.dataset;
  const at = source.href.match(/^(.*)\/api\/web\/chat\.js(?:[?#].*)?$/);
  let url = said.url ?? (at ? at[1] : source.origin);
  let agent = said.agent ?? "";
  if (agent.includes("/") && !said.url) {
    const [workspace, id] = agent.split("/");
    url = `${source.origin}/w/${encodeURIComponent(workspace)}`;
    agent = id;
  }
  if (!agent) return console.error("chloe chat: the script tag needs data-agent.");
  if (!said.pass) return console.error("chloe chat: the script tag needs data-pass, the address on your site that gives a pass.");
  const pass = async () => {
    const answer = await fetch(said.pass, { method: "POST", credentials: "same-origin" });
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new Error(body.error || "The chat could not start.");
    return body;
  };

  import(new URL("client.js", source).href).then(({ chloeChat }) => draw(chloeChat({ url, agent, pass })));

  function draw(chat) {
    const host = document.createElement("div");
    host.setAttribute("data-chloe-chat", "");
    const root = host.attachShadow({ mode: "open" });
    const left = said.position === "left";
    root.innerHTML = `
      <style>${STYLE}</style>
      <button class="open ${left ? "left" : ""}" type="button" aria-label="Open the chat" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/></svg>
      </button>
      <section class="panel ${left ? "left" : ""}" role="dialog" aria-label="Chat" hidden>
        <header>
          <div><h2></h2><p class="note"></p></div>
          <button class="clear" type="button" title="Start over" aria-label="Start over">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/></svg>
          </button>
          <button class="close" type="button" title="Close" aria-label="Close the chat">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>
        <div class="log" role="log" aria-live="polite"></div>
        <p class="doing" aria-live="polite" hidden><span class="dots"><i></i><i></i><i></i></span><span class="what"></span></p>
        <form>
          <label class="hidden" for="chloe-text">Your message</label>
          <button class="attach" type="button" aria-label="Add a picture" hidden>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8"/></svg>
          </button>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
          <textarea id="chloe-text" rows="1" maxlength="4000" placeholder="Write a message"></textarea>
          <button class="send" type="submit" aria-label="Send" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </form>
        <p class="pictures" hidden></p>
      </section>`;
    document.body.append(host);

    const $ = (selector) => root.querySelector(selector);
    const opener = $(".open");
    const panel = $(".panel");
    const log = $(".log");
    const doing = $(".doing");
    const form = $("form");
    const text = $("textarea");
    const send = $(".send");
    const attach = $(".attach");
    const file = $("input[type=file]");
    const picked = $(".pictures");
    $("h2").textContent = said.title || "Chat";
    $(".note").textContent = said.note ?? `An AI agent, run by ${location.hostname}`;

    let loaded = false;
    let busy = null;
    let images = [];

    function bubble(role, words) {
      const one = document.createElement("div");
      one.className = `message ${role}`;
      if (role === "user") one.textContent = words;
      else one.append(...markdown(words));
      log.append(one);
      log.scrollTop = log.scrollHeight;
      return one;
    }

    function say(words, kind = "error") {
      const one = document.createElement("p");
      one.className = kind;
      one.textContent = words;
      log.append(one);
      log.scrollTop = log.scrollHeight;
    }

    function working(what) {
      doing.hidden = what === null;
      $(".what").textContent = what ?? "";
      log.scrollTop = log.scrollHeight;
    }

    async function load() {
      if (loaded) return;
      loaded = true;
      try {
        const { pictures } = await chat.start();
        attach.hidden = !pictures;
        const { greeting, messages } = await chat.history();
        log.replaceChildren();
        if (greeting) bubble("assistant", greeting);
        for (const one of messages) bubble(one.role, one.text);
      } catch (error) {
        loaded = false;
        say(error.message);
      }
    }

    function open(yes) {
      panel.hidden = !yes;
      opener.hidden = yes;
      opener.setAttribute("aria-expanded", String(yes));
      if (yes) {
        load();
        text.focus();
      } else opener.focus();
    }

    async function ask(words) {
      if (busy || (!words && !images.length)) return;
      bubble("user", [words, ...images.map((one) => `(${one.name})`)].filter(Boolean).join("\n"));
      text.value = "";
      fit();
      const sending = images;
      images = [];
      showPicked();
      busy = new AbortController();
      send.disabled = true;
      working("");
      let draft = null;
      try {
        const { text: answer } = await chat.send(words, {
          images: sending,
          signal: busy.signal,
          onText: (soFar) => {
            working(null);
            draft ??= bubble("assistant", "");
            draft.replaceChildren(...markdown(soFar));
            log.scrollTop = log.scrollHeight;
          },
          onSaid: (words) => {
            if (draft) draft = null;
            else bubble("assistant", words);
          },
          onStep: ({ text: what }) => working(what),
        });
        if (draft) draft.replaceChildren(...markdown(answer));
        else if (answer) bubble("assistant", answer);
      } catch (error) {
        if (error.name !== "AbortError") say(error.message);
      } finally {
        busy = null;
        working(null);
        send.disabled = !text.value.trim();
      }
    }

    function fit() {
      text.style.height = "auto";
      text.style.height = `${Math.min(text.scrollHeight, 128)}px`;
      send.disabled = Boolean(busy) || (!text.value.trim() && !images.length);
    }

    function showPicked() {
      picked.hidden = !images.length;
      picked.textContent = images.map((one) => one.name).join(", ");
      fit();
    }

    opener.addEventListener("click", () => open(true));
    $(".close").addEventListener("click", () => open(false));
    $(".clear").addEventListener("click", async () => {
      if (busy) busy.abort();
      try {
        await chat.clear();
        loaded = false;
        await load();
      } catch (error) {
        say(error.message);
      }
    });
    panel.addEventListener("keydown", (event) => event.key === "Escape" && open(false));
    text.addEventListener("input", fit);
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        ask(text.value.trim());
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      ask(text.value.trim());
    });
    attach.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      for (const one of [...file.files].slice(0, 2 - images.length)) {
        if (one.size > 3_000_000) {
          say(`${one.name} is too big. Pictures up to 3 MB.`);
          continue;
        }
        const url = await new Promise((done) => {
          const reader = new FileReader();
          reader.onload = () => done(String(reader.result));
          reader.readAsDataURL(one);
        });
        images.push({ name: one.name, mediaType: one.type, data: url.slice(url.indexOf(",") + 1) });
      }
      file.value = "";
      showPicked();
    });

    if ("open" in said) open(true);
  }

  /** Markdown as DOM nodes, made with text only: paragraphs, lists, code, bold, italics and links. */
  function markdown(words) {
    const nodes = [];
    const blocks = words.replace(/\r/g, "").split(/\n{2,}/);
    for (let i = 0; i < blocks.length; i++) {
      let block = blocks[i];
      if (block.startsWith("```")) {
        while (!/```\s*$/.test(block.slice(3)) && i + 1 < blocks.length) block += `\n\n${blocks[++i]}`;
        const pre = document.createElement("pre");
        pre.textContent = block.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
        nodes.push(pre);
        continue;
      }
      const lines = block.split("\n").filter((line) => line.trim());
      if (!lines.length) continue;
      const bullet = /^\s*(?:[-*]|\d+[.)])\s+/;
      if (lines.every((line) => bullet.test(line))) {
        const list = document.createElement(/^\s*\d/.test(lines[0]) ? "ol" : "ul");
        for (const line of lines) {
          const item = document.createElement("li");
          item.append(...inline(line.replace(bullet, "")));
          list.append(item);
        }
        nodes.push(list);
        continue;
      }
      const p = document.createElement("p");
      lines.forEach((line, n) => {
        if (n) p.append(document.createElement("br"));
        p.append(...inline(line.replace(/^#{1,6}\s+/, "")));
      });
      nodes.push(p);
    }
    return nodes;
  }

  function inline(line) {
    const out = [];
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let last = 0;
    for (const found of line.matchAll(pattern)) {
      if (found.index > last) out.push(document.createTextNode(line.slice(last, found.index)));
      const [, code, bold, em1, em2, label, href, bare] = found;
      if (code !== undefined) out.push(element("code", code));
      else if (bold !== undefined) out.push(element("strong", bold));
      else if (em1 !== undefined || em2 !== undefined) out.push(element("em", em1 ?? em2));
      else out.push(link(label ?? bare, href ?? bare));
      last = found.index + found[0].length;
    }
    if (last < line.length) out.push(document.createTextNode(line.slice(last)));
    return out;
  }

  function element(tag, words) {
    const one = document.createElement(tag);
    one.textContent = words;
    return one;
  }

  function link(words, href) {
    if (!/^(https?:|mailto:)/i.test(href)) return document.createTextNode(words);
    const a = element("a", words.replace(/^https?:\/\//, ""));
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .open, .panel {
      --accent: var(--chloe-accent, #2f5bd3);
      --font: var(--chloe-font, system-ui, -apple-system, "Segoe UI", sans-serif);
      --radius: var(--chloe-radius, 14px);
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483000; font: 15px/1.45 var(--font); color: #1b1d22;
    }
    .left { right: auto; left: 20px; }
    .open {
      width: 56px; height: 56px; border-radius: 50%; border: 0; background: var(--accent); color: #fff; cursor: pointer;
      display: grid; place-items: center; box-shadow: 0 6px 20px rgba(0, 0, 0, .2);
    }
    .open[hidden], .panel[hidden], [hidden] { display: none !important; }
    svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .open svg { fill: currentColor; stroke: none; width: 26px; height: 26px; }
    .panel {
      width: 380px; height: min(600px, calc(100vh - 40px)); display: flex; flex-direction: column; background: #fff;
      border-radius: var(--radius); box-shadow: 0 12px 40px rgba(0, 0, 0, .22); overflow: hidden;
    }
    header { display: flex; align-items: center; gap: 4px; padding: 12px 10px 12px 16px; border-bottom: 1px solid #e7e8ec; }
    header div { flex: 1; min-width: 0; }
    h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .note { margin: 2px 0 0; font-size: 12px; color: #6b6f7a; }
    header button, .attach { border: 0; background: none; color: #6b6f7a; padding: 6px; border-radius: 8px; cursor: pointer; display: grid; }
    header button:hover, .attach:hover { background: #f1f2f5; color: #1b1d22; }
    .log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .message { max-width: 85%; padding: 9px 12px; border-radius: var(--radius); overflow-wrap: anywhere; }
    .message.user { align-self: flex-end; background: var(--accent); color: #fff; white-space: pre-wrap; }
    .message.assistant { align-self: flex-start; background: #f1f2f5; }
    .message p, .message ul, .message ol, .message pre { margin: 0 0 8px; }
    .message > :last-child { margin-bottom: 0; }
    .message ul, .message ol { padding-left: 20px; }
    .message code, .message pre { font: 13px/1.4 ui-monospace, Menlo, monospace; background: rgba(0, 0, 0, .06); border-radius: 4px; }
    .message code { padding: 1px 4px; }
    .message pre { padding: 8px; white-space: pre-wrap; }
    .message a { color: inherit; }
    .error { align-self: center; margin: 0; font-size: 13px; color: #a3242a; text-align: center; }
    .doing { margin: 0; padding: 0 16px 8px; font-size: 13px; color: #6b6f7a; display: flex; align-items: center; gap: 8px; }
    .dots { display: inline-flex; gap: 3px; }
    .dots i { width: 6px; height: 6px; border-radius: 50%; background: #9a9eaa; animation: blink 1.2s infinite ease-in-out; }
    .dots i:nth-child(2) { animation-delay: .2s; }
    .dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: .3; } 40% { opacity: 1; } }
    form { display: flex; align-items: flex-end; gap: 6px; padding: 10px; border-top: 1px solid #e7e8ec; }
    textarea {
      flex: 1; resize: none; border: 1px solid #d6d8de; border-radius: 10px; padding: 9px 11px; font: inherit; color: inherit;
      max-height: 128px; outline: none;
    }
    textarea:focus { border-color: var(--accent); }
    .send { border: 0; background: var(--accent); color: #fff; width: 40px; height: 40px; border-radius: 10px; cursor: pointer; display: grid; place-items: center; }
    .send:disabled { opacity: .4; cursor: default; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .pictures { margin: 0; padding: 0 12px 10px; font-size: 12px; color: #6b6f7a; }
    .hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    @media (max-width: 520px) {
      .panel { inset: 0; width: auto; height: auto; border-radius: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dots i { animation: none; opacity: .6; }
    }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1c1e23; color: #e8e9ec; }
      header, form { border-color: #30333a; }
      .message.assistant { background: #2a2d33; }
      header button:hover, .attach:hover { background: #2a2d33; color: #e8e9ec; }
      textarea { background: #15171b; border-color: #3a3d45; }
      .error { color: #ff8a8f; }
    }
  `;
})();
