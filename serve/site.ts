// The runtime's own site: which agents are loaded, what each one is configured
// to do, the API docs, the tokens, and the notes folder if one is configured.
//
// Plain HTML written by hand, with no build step and no dependencies, because
// a build step in the runtime is the thing this site exists to avoid. It is
// deliberately basic. A package that offers a better page takes over every
// address here except the docs: see page.ts.
//
// Server rendered, so the only script on the page is the few lines a form
// needs. Everything it shows, it was given.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Agent } from "#chloe/load/load.ts";
import { caller, from, hasAccount } from "./login.ts";
import { installedPage, servePageFile } from "./page.ts";
import { memoryLabel, memoryTree } from "./memory.ts";
import { makePass } from "./pass.ts";
import { describe } from "#chloe/timer/every.ts";

/** What the docs page needs to know about a route. http.ts's Route is this plus its handler. */
export interface RouteDoc {
  method: string;
  path: string;
  does: string;
  takes?: string;
  open?: boolean;
  token?: boolean;
  needsApiChannel?: boolean;
}

interface Context {
  agent(name: string): Agent;
  agents(): Map<string, Agent>;
}

/**
 * Everything that is not /api. The installed page gets first refusal, and the
 * built-in one answers when there is none.
 */
export async function sitePage(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  context: Context,
): Promise<void> {
  const page = installedPage();
  if (page) return void (await servePageFile(response, page, path));

  const who = caller(request);
  // The site is the account's. A token is for the API, and giving it a browser
  // session would quietly widen what it can reach.
  if (!who || who.kind !== "account") {
    if (path === "/login") return send(response, loginPage());
    return away(response, "/login");
  }
  if (path === "/login") return away(response, "/");

  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);

  if (path === "/") return send(response, homePage(context));
  if (parts[0] === "agents" && parts[1] && parts.length === 2) {
    return send(response, agentPage(context.agent(parts[1]), context));
  }
  if (path === "/tokens") return send(response, tokensPage(context));
  // One agent's memory lives under that agent, the same as everything else of its.
  if (parts[0] === "agents" && parts[1] && parts[2] === "memory") {
    return send(response, await memoryPage(context.agent(parts[1]), parts.slice(3).join("/"), from(request)));
  }
  send(response, shell("Not here", `<h1>Not here</h1><p>No page at <code>${esc(path)}</code>.</p>`), 404);
}

function send(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function away(response: ServerResponse, to: string): void {
  response.writeHead(303, { location: to });
  response.end();
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `
:root { color-scheme: light dark; --ink:#1b1a18; --paper:#fbfaf8; --quiet:#6b6862; --line:#e4e0d9; --link:#1f5f8b; }
@media (prefers-color-scheme: dark) {
  :root { --ink:#e8e5df; --paper:#171614; --quiet:#948f86; --line:#2e2c28; --link:#7fb5d8; }
}
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1rem 4rem; background:var(--paper); color:var(--ink);
  font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size:1.5rem; margin:0 0 .25rem; }
h2 { font-size:1.05rem; margin:2rem 0 .5rem; }
h3 { font-size:.95rem; margin:1.25rem 0 .35rem; }
a { color:var(--link); }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:.875em; }
pre { background:color-mix(in srgb, var(--ink) 5%, transparent); padding:.75rem; border-radius:6px; overflow:auto; }
nav { display:flex; gap:1rem; flex-wrap:wrap; margin:0 0 2rem; padding-bottom:.75rem; border-bottom:1px solid var(--line); }
nav a { text-decoration:none; }
.quiet { color:var(--quiet); }
.card { border:1px solid var(--line); border-radius:8px; padding:1rem; margin:.75rem 0; }
.card h3 { margin-top:0; }
table { border-collapse:collapse; width:100%; margin:.5rem 0 1rem; }
th, td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; font-size:.8rem; color:var(--quiet); text-transform:uppercase; letter-spacing:.04em; }
form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; margin:.75rem 0; }
input, button { font:inherit; padding:.45rem .6rem; border:1px solid var(--line); border-radius:6px;
  background:var(--paper); color:var(--ink); }
button { cursor:pointer; background:color-mix(in srgb, var(--ink) 8%, transparent); }
.tag { font-size:.75rem; padding:.1rem .4rem; border-radius:4px; border:1px solid var(--line); color:var(--quiet); }
ul.tree { list-style:none; padding-left:1rem; margin:.25rem 0; }
iframe { width:100%; height:32rem; border:1px solid var(--line); border-radius:6px; background:var(--paper); }
`;

/**
 * Chloe's colours as a data URI, rather than a file and a route to serve it.
 * A browser asks for /favicon.ico on every page whether one is offered or not,
 * and an unanswered one is a 404 in the console of every page this site has.
 */
const ICON =
  `<link rel="icon" href="data:image/svg+xml,` +
  `%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E` +
  `%3Crect width='32' height='32' rx='8' fill='%231d473b'/%3E` +
  `%3Ccircle cx='16' cy='16' r='6' fill='%23f4efe1'/%3E%3C/svg%3E">`;

function shell(title: string, body: string, nav = true): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${ICON}
<style>${STYLE}</style>
<main>
${nav ? `<nav>
  <a href="/">Agents</a>
  <a href="/api">API</a>
  <a href="/tokens">Tokens</a>
  <a href="#" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location='/login');return false">Sign out</a>
</nav>` : ""}
${body}
</main>
</html>`;
}

function loginPage(): string {
  const making = !hasAccount();
  return shell(
    making ? "Make the account" : "Sign in",
    `<h1>${making ? "Make the account" : "Sign in"}</h1>
<p class="quiet">${
      making
        ? "This copy has no account yet. The first one is made here, or with <code>npm run account</code> on the box."
        : "One account. Everything behind it is the agents, what they have run, and whatever folders they keep."
    }</p>
<form onsubmit="return go(this)">
  <input name="username" placeholder="Username" autocomplete="username" required>
  <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
  <button>${making ? "Make it" : "Sign in"}</button>
</form>
<p id="trouble" class="quiet"></p>
<script>
function go(form) {
  fetch(${making ? "'/api/setup'" : "'/api/login'"}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: form.username.value, password: form.password.value }),
  })
    .then((r) => r.json())
    .then((a) => { if (a.ok) location = '/'; else document.getElementById('trouble').textContent = a.error; })
    .catch((e) => { document.getElementById('trouble').textContent = String(e); });
  return false;
}
</script>`,
    false,
  );
}

function homePage(context: Context): string {
  const agents = [...context.agents().values()];
  const body = `<h1>Chloe</h1>
<p class="quiet">${agents.length} agent${agents.length === 1 ? "" : "s"} loaded. This is the runtime's own site.
Install a package that offers a page and it takes over from here.</p>

${agents
  .map(
    (agent) => `<div class="card">
  <h3><a href="/agents/${esc(agent.name)}">${esc(agent.label || agent.name)}</a>
    ${Object.keys(agent.channels).includes("api") ? '<span class="tag">on the api</span>' : ""}</h3>
  <p class="quiet">${esc(agent.description || "No description.")}</p>
  <p class="quiet"><code>${esc(agent.model)}</code> &middot; ${agent.jobs.length} job${
      agent.jobs.length === 1 ? "" : "s"
    } &middot; ${agent.skills.length} skill${agent.skills.length === 1 ? "" : "s"}
    &middot; <a href="/agents/${esc(agent.name)}/memory">${esc(memoryLabel(agent))}</a></p>
</div>`,
  )
  .join("\n")}

<h2>Where things are</h2>
<table>
  <tr><th>The API</th><td><a href="/api">/api</a> lists every route it answers.</td></tr>
  <tr><th>Tokens</th><td><a href="/tokens">/tokens</a> makes and revokes them, for other systems.</td></tr>
</table>`;
  return shell("Chloe", body);
}

function agentPage(agent: Agent, context: Context): string {
  const body = `<h1>${esc(agent.label || agent.name)}</h1>
<p class="quiet">${esc(agent.description || "No description.")}</p>
<p class="quiet">This page is read only. Its folder is on disk, and an edit there is live in under a second.</p>

<table>
  <tr><th>Name</th><td><code>${esc(agent.name)}</code></td></tr>
  <tr><th>Model</th><td><code>${esc(agent.model)}</code></td></tr>
  <tr><th>Channels</th><td>${
    Object.keys(agent.channels).length
      ? Object.keys(agent.channels).sort().map((one) => `<code>${esc(one)}</code>`).join(", ")
      : '<span class="quiet">none</span>'
  }</td></tr>
  <tr><th>Tools</th><td>${
    Object.keys(agent.tools ?? {}).length
      ? Object.keys(agent.tools ?? {}).sort().map((one) => `<code>${esc(one)}</code>`).join(", ")
      : '<span class="quiet">none</span>'
  }</td></tr>
  <tr><th>Skills</th><td>${
    agent.skills.length
      ? agent.skills.map((one) => `<code>${esc(one.name)}</code>`).join(", ")
      : '<span class="quiet">none</span>'
  }</td></tr>
</table>

<h2>Jobs</h2>
${
  agent.jobs.length
    ? `<table>
<tr><th>Job</th><th>When</th><th>How</th><th>What it does</th></tr>
${agent.jobs
  .map(
    (job) => `<tr>
  <td><code>${esc(job.id)}</code></td>
  <td>${job.cron ? esc(describe(job.cron, job.timezone)) : '<span class="quiet">when started</span>'}</td>
  <td>${job.run ? "code" : esc(job.model ?? agent.model)}</td>
  <td class="quiet">${esc(job.description ?? "")}</td>
</tr>`,
  )
  .join("\n")}
</table>`
    : '<p class="quiet">No jobs.</p>'
}

<h2>Reaching it</h2>
${
  Object.keys(agent.channels).includes("api")
    ? `<p>It binds an api channel, so a token may talk to it and run its jobs.</p>
<pre>curl -X POST http://127.0.0.1:3067/api/agents/${esc(agent.name)}/chat \\
  -H "authorization: Bearer $CHLOE_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"prompt":"what is late?"}'</pre>`
    : `<p class="quiet">It has no api channel, so only a signed-in account can talk to it.
Add <code>channels: { api }</code> to its definition to open it to a token.</p>`
}`;
  return shell(agent.label || agent.name, body);
}

function tokensPage(context: Context): string {
  const body = `<h1>Tokens</h1>
<p class="quiet">For another system to read this API and reach the agents that bind an api channel.
A token cannot write files, make tokens or revoke them. The secret is shown once and is not stored.</p>

<form onsubmit="return make(this)">
  <input name="name" placeholder="What is it for" required>
  <button>Make one</button>
</form>
<pre id="made" hidden></pre>

<table id="list"><tr><th>Name</th><th>Made</th><th>Last used</th><th></th></tr></table>

<script>
function draw(tokens) {
  const rows = tokens.map((t) => {
    const when = t.revoked
      ? '<span class="quiet">revoked ' + t.revoked.slice(0, 10) + '</span>'
      : '<button onclick="revoke(\\'' + t.id + '\\')">Revoke</button>';
    return '<tr><td>' + t.name + '</td><td class="quiet">' + t.created.slice(0, 10) + '</td><td class="quiet">' +
      (t.lastUsed ? t.lastUsed.slice(0, 16).replace('T', ' ') : 'never') + '</td><td>' + when + '</td></tr>';
  });
  document.getElementById('list').innerHTML =
    '<tr><th>Name</th><th>Made</th><th>Last used</th><th></th></tr>' + rows.join('');
}
function load() { fetch('/api/tokens').then((r) => r.json()).then(draw); }
function make(form) {
  fetch('/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: form.name.value }),
  })
    .then((r) => r.json())
    .then((t) => {
      const shown = document.getElementById('made');
      shown.hidden = false;
      shown.textContent = t.secret
        ? t.name + '\\n\\n' + t.secret + '\\n\\nCopy it now. It is not stored and cannot be shown again.'
        : t.error;
      form.reset();
      load();
    });
  return false;
}
function revoke(id) {
  fetch('/api/tokens/' + id + '/revoke', { method: 'POST' }).then(load);
}
load();
</script>`;
  return shell("Tokens", body);
}

async function memoryPage(agent: Agent, path: string, at: string): Promise<string> {
  const label = memoryLabel(agent);
  const here = `/agents/${agent.name}/memory`;

  if (!path) {
    const tree = await memoryTree(agent, at);
    return shell(
      `${agent.name}: ${label}`,
      `<h1>${esc(agent.label || agent.name)}&rsquo;s ${esc(label.toLowerCase())}</h1>
<p class="quiet"><code>${esc(agent.memory.folder)}</code>. Every file opened here is written to the audit log,
which reading the same file from a shell is not. That difference is deliberate.</p>
${drawTree(here, tree)}`,
    );
  }

  // In a frame, under a pass, sandboxed. See pass.ts and framed() in http.ts:
  // the file runs its own script and cannot reach this page or the API.
  const src = `/memory/${encodeURIComponent(makePass(agent.name))}/${path.split("/").map(encodeURIComponent).join("/")}`;
  return shell(
    path,
    `<p class="quiet"><a href="${esc(here)}">${esc(label)}</a> / ${esc(path)}</p>
<iframe src="${esc(src)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" title="${esc(path)}"></iframe>`,
  );
}

function drawTree(here: string, entries: { name: string; path: string; dir: boolean; children?: unknown }[]): string {
  if (!entries.length) return '<p class="quiet">Nothing here.</p>';
  return `<ul class="tree">${entries
    .map(
      (one) =>
        `<li>${one.dir ? `<span class="quiet">${esc(one.name)}/</span>` : `<a href="${esc(here)}/${esc(one.path)}">${esc(one.name)}</a>`}${
          one.dir && Array.isArray(one.children) && one.children.length
            ? drawTree(here, one.children as { name: string; path: string; dir: boolean }[])
            : ""
        }</li>`,
    )
    .join("")}</ul>`;
}

/** The API docs, generated from the same list the router dispatches on. */
export function docsPage(routes: RouteDoc[]): string {
  const groups: [string, (one: RouteDoc) => boolean][] = [
    ["The ways in", (one) => Boolean(one.open)],
    ["Reading", (one) => !one.open && Boolean(one.token) && one.method === "GET"],
    ["Talking to an agent", (one) => Boolean(one.needsApiChannel)],
    ["The account's own", (one) => !one.open && !one.token],
  ];
  const body = `<h1>The API</h1>
<p class="quiet">Every route this runtime answers. It binds <code>127.0.0.1:3067</code> and is not meant to be
put on a public name: reach it from another machine over a tunnel.</p>

<h2>Who may call what</h2>
<table>
  <tr><th>anybody</th><td>The four ways in. Each says as little as it can.</td></tr>
  <tr><th>account</th><td>Somebody signed in on this box, as the cookie or as
    <code>Authorization: Bearer &lt;the value /api/login returned&gt;</code>. Can do everything.</td></tr>
  <tr><th>token</th><td>Another system, as <code>Authorization: Bearer chloe_...</code>. Reading, plus chat and
    jobs for the agents that bind an api channel. Never writing, and never the tokens themselves.
    Made at <a href="/tokens">/tokens</a>.</td></tr>
</table>

${groups
  .map(([title, pick]) => {
    const found = routes.filter(pick);
    if (!found.length) return "";
    return `<h2>${esc(title)}</h2>
<table>
${found
  .map(
    (one) => `<tr>
  <td><code>${esc(one.method)} ${esc(one.path)}</code>${
      one.takes ? `<br><span class="quiet"><code>${esc(one.takes)}</code></span>` : ""
    }</td>
  <td>${esc(one.does)}</td>
</tr>`,
  )
  .join("\n")}
</table>`;
  })
  .join("\n")}

<h2>From something that is not a browser</h2>
<pre>curl http://127.0.0.1:3067/api/agents -H "authorization: Bearer $CHLOE_TOKEN"</pre>
<p class="quiet">The same list as JSON is this page with no <code>Accept: text/html</code>:</p>
<pre>curl http://127.0.0.1:3067/api</pre>`;
  return shell("The API", body);
}
