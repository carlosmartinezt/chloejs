// Every route is in this file, so what is reachable from outside is this file
// and nothing else, plus whatever paths a running channel answers. It binds
// loopback. What answers the addresses that are not /api is site.ts.
//
// The routes are a list rather than a run of ifs, because the docs at GET /api
// are generated from that list. A route nobody wrote down is a route nobody
// documented, and a documented route that does not exist is worse than either.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { z } from "zod";

import { db, RUN_COLUMNS } from "#chloe/core/db";
import { settings } from "#chloe/core/settings";
import { hasChannel, type Agent, type ChannelRoute, type Job } from "#chloe/load/load";
import type { Clock } from "#chloe/core/clock";
import { choices, choose, modelFor, type Scope } from "#chloe/model/choices";
import { forget, recall } from "#chloe/model/memory";
import { models } from "#chloe/model/model";
import { agentChange, agentChanges, agentSeen, agentUndo, placeOf } from "./changes.ts";
import { editable, open, save, tree } from "./files.ts";
import {
  memoryCommit,
  memoryDelete,
  memoryGit,
  memoryLabel,
  memoryLog,
  memoryOpen,
  memoryPull,
  memoryPush,
  memoryRaw,
  memoryRename,
  memorySave,
  memoryTree,
} from "./memory.ts";
import { checkPass, makePass } from "./pass.ts";
import { BadRequest, NotFound } from "./errors.ts";
import { recentWork } from "./recentWork.ts";
import { channelsOf, connectionsOf, toolsOf } from "./inside.ts";
import { describe } from "#chloe/timer/every";
import { type Caller, caller, covers, createAccount, from, hasAccount, overHttps, relayUnder, relayedBy, renew, setCookie, signIn } from "./login.ts";
import { makeToken, revokeToken, tokens } from "./tokens.ts";
import { signedInFrom } from "./alerts.ts";
import { docsPage, type RouteDoc, sitePage } from "./site.ts";
import { receive } from "#chloe/channels/shared";
import { answer, checkInput, parkedRuns } from "#chloe/core/steps";

/**
 * Where this server listens. Loopback, and one port for the agents, the API
 * and the site alike. Written down here, beside the only thing that binds it,
 * and not settable: a port that moves is a tunnel that stops finding it.
 */
export const HOST = "127.0.0.1";
export const PORT = 3067;

export interface Context {
  agent(name: string): Agent;
  agents(): Map<string, Agent>;
  clock: Clock;
  body: typeof body;
  json(response: ServerResponse, value: unknown, status?: number): void;
}

/** Everything one route handler is given. */
export interface At {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** Whatever the `:parts` of this route's path caught. */
  params: Record<string, string>;
  context: Context;
  who: Caller;
}

/**
 * One route. It carries its own documentation because GET /api is generated
 * from this list: a route and the line describing it cannot drift apart when
 * they are the same object.
 *
 *   path             like `/api/agents/:name/log`. A `:part` matches one segment.
 *   open             answered without a session or a token.
 *   token            a token may call it. Without this, only the account may.
 *   needsApiChannel  for a token, only when that agent binds an api channel.
 *   remote           the switch or switches in `cloud.remote` a request sent
 *                    through the dashboard needs, all on. Without one, the
 *                    route is never answered through the cloud, whatever the
 *                    settings say: signing in, setting up, and the tokens.
 */
export interface Route extends RouteDoc {
  method: "GET" | "POST";
  remote?: Remote | Remote[];
  handle(at: At): Promise<void> | void;
}

/** The switches in `cloud.remote` in settings, each a thing the dashboard may ask for. */
export type Remote = "read" | "chat" | "run" | "memory" | "write";

/** Whether an agent has opted in to being reached by another system. */
function onTheApi(agent: Agent): boolean {
  return hasChannel(agent, "api");
}

/** One agent's configuration, the same shape from the list, from its own route, and as sent to a cloud. */
export function summary(agent: Agent) {
  return {
    name: agent.name,
    label: agent.label,
    description: agent.description,
    /** What its runs go to now: a choice made on the fly, else what its definition names. */
    model: modelFor(agent),
    /** What its definition names. */
    declaredModel: agent.model,
    /** Every choice made on the fly: for everything it does, for one job, or for one chat. */
    chosen: choices(agent.name),
    channels: agent.channels.map((one) => one.name).sort(),
    /** Whether a token may chat to it or run its jobs. */
    api: onTheApi(agent),
    /** What the site calls its memory. Every agent has one. */
    memory: memoryLabel(agent),
    tools: Object.keys(agent.tools ?? {}).sort(),
    skills: agent.skills.map((s) => s.name),
    jobs: agent.jobs.map((s) => ({
      id: s.id,
      description: s.description,
      cron: s.cron,
      // In words when it is one every() could have written, like "weekdays at 09:30 UTC".
      when: s.cron ? describe(s.cron, s.timezone) : undefined,
      timezone: s.timezone,
      // A job made of code has no model until one of its steps asks for one.
      model: s.run ? "code" : modelFor(agent, s),
      code: Boolean(s.run),
      files: s.files,
    })),
  };
}

/**
 * What the log says a run came in on. `npm run agent` and the cloud both come
 * in over the API and say so in a header, so the log can tell a person at a
 * terminal, and somebody pressing a button on a dashboard, from another system
 * holding a token. Anything else is "api".
 */
const CHANNELS = ["terminal", "cloud"];

function channelOf(request: IncomingMessage): string {
  const said = request.headers["x-chloe-channel"];
  return typeof said === "string" && CHANNELS.includes(said) ? said : "api";
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/api",
    does: "This list: every route, what it does and who may call it.",
    open: true,
    remote: "read",
    handle: ({ request, response }) => {
      // A browser gets the page. Anything else gets the same thing as JSON.
      if ((request.headers.accept ?? "").includes("text/html")) return void html(response, docsPage(routes));
      json(response, routeList());
    },
  },

  // The ways in. These five are the whole of what is answered without a
  // session, and each says as little as it can.
  {
    method: "GET",
    path: "/api/account",
    does: "Whether this copy has a password yet, so a page knows which form to show.",
    open: true,
    handle: ({ response }) => json(response, { exists: hasAccount() }),
  },
  {
    method: "POST",
    path: "/api/login",
    does: "Sign in. Sets the cookie, and hands back the same value for anything that is not a browser.",
    takes: '{"password": "..."}',
    open: true,
    handle: (at) => wayIn(at, false),
  },
  {
    method: "POST",
    path: "/api/setup",
    does: "Set the one password, when there is none. Refused once one is set.",
    takes: '{"password": "..."}',
    open: true,
    handle: (at) => wayIn(at, true),
  },
  {
    method: "POST",
    path: "/api/logout",
    does: "End the session.",
    open: true,
    handle: ({ request, response }) => {
      response.setHeader("set-cookie", setCookie("", overHttps(request)));
      json(response, { ok: true });
    },
  },
  {
    method: "GET",
    path: "/api/check",
    does: "204 when the account is signed in, 401 when not. For a proxy in front of another site under the same login.",
    handle: ({ response }) => {
      response.writeHead(204).end();
    },
  },
  {
    method: "GET",
    path: "/api/back",
    does: "Sends a signed-in browser back to ?to=, an https address under login.domain in chloe.config.ts. Anybody else goes to the sign-in page first.",
    takes: "?to=https://...",
    open: true,
    handle: ({ request, response, url }) => {
      const to = url.searchParams.get("to") ?? "";
      if (!covers(to)) return void response.writeHead(302, { location: "/" }).end();
      if (caller(request)?.kind !== "account") {
        return void response.writeHead(302, { location: `/login?back=${encodeURIComponent(to)}` }).end();
      }
      response.setHeader("set-cookie", setCookie(renew(), overHttps(request)));
      response.writeHead(302, { location: to }).end();
    },
  },

  // Reading. A token may do all of this.
  {
    method: "GET",
    path: "/api/agents",
    does: "Every agent that is loaded, with its configuration.",
    token: true,
    remote: "read",
    handle: ({ response, context }) => json(response, [...context.agents().values()].map(summary)),
  },
  {
    method: "GET",
    path: "/api/agents/:name",
    does: "One agent's configuration: its model, tools, skills, channels and jobs.",
    token: true,
    remote: "read",
    handle: ({ response, context, params }) => json(response, summary(context.agent(params.name))),
  },
  {
    method: "GET",
    path: "/api/agents/:name/instructions",
    does: "What it is told to do, as the model is given it, and which file it is in when it is in one.",
    token: true,
    remote: "read",
    handle: ({ response, context, params }) => {
      const agent = context.agent(params.name);
      return json(response, { text: agent.instructions, path: agent.instructionsFile });
    },
  },
  {
    method: "GET",
    path: "/api/agents/:name/skills",
    does: "Its skills, each with what it says. A skill is words it reaches for when it needs them.",
    token: true,
    remote: "read",
    handle: ({ response, context, params }) =>
      json(
        response,
        context
          .agent(params.name)
          .skills.map((one) => ({ name: one.name, description: one.description, body: one.body, path: one.file })),
      ),
  },
  {
    method: "GET",
    path: "/api/agents/:name/tools",
    does: "What it can do: every tool it is bound, with what the model is told each one is for.",
    token: true,
    remote: "read",
    handle: ({ response, context, params }) => json(response, toolsOf(context.agent(params.name))),
  },
  {
    method: "GET",
    path: "/api/agents/:name/channels",
    does: "The ways in it binds, and which setting carries each one's credentials. Never the credentials.",
    token: true,
    remote: "read",
    handle: ({ response, context, params }) => json(response, channelsOf(context.agent(params.name))),
  },
  {
    method: "GET",
    path: "/api/agents/:name/connections",
    does: "What it can reach that is not on this box, and whether each is set up. Never the credentials.",
    token: true,
    remote: "read",
    handle: ({ response, context, params }) => json(response, connectionsOf(context.agent(params.name))),
  },
  {
    method: "GET",
    path: "/api/models",
    does: "The models somebody may pick, each with the route it goes by on this box. ?agent= adds what that agent and its jobs name.",
    token: true,
    remote: "read",
    handle: ({ response, context, url }) => {
      const name = url.searchParams.get("agent");
      json(response, models(name ? context.agent(name) : undefined));
    },
  },
  {
    method: "GET",
    path: "/api/agents/:name/log",
    does: "That agent's runs, newest first. Takes ?limit=, at most 200.",
    token: true,
    remote: "read",
    handle: ({ response, context, params, url }) => {
      context.agent(params.name);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      json(
        response,
        db
          .prepare(`select ${RUN_COLUMNS} from runs where agent = ? order by started desc limit ?`)
          .all(params.name, limit),
      );
    },
  },
  {
    method: "GET",
    path: "/api/agents/:name/files",
    does: "That agent's own folder as a tree: its instructions, skills, scripts and jobs.",
    token: true,
    remote: "read",
    handle: async ({ response, context, params }) => {
      context.agent(params.name);
      json(response, await tree(params.name));
    },
  },
  {
    method: "GET",
    path: "/api/agents/:name/file",
    does: "One file in that folder. Takes ?path=, and a folder answers with what is in it.",
    token: true,
    remote: "read",
    handle: async ({ response, context, params, url }) => {
      context.agent(params.name);
      const path = url.searchParams.get("path");
      if (!path) return json(response, { error: "No path." }, 400);
      const found = await open(params.name, path);
      if (!found) throw new NotFound(`${params.name} has no ${path}.`);
      json(response, found);
    },
  },
  {
    method: "GET",
    path: "/api/agents/:name/threads",
    does: "That agent's conversations, newest first, however they were started.",
    token: true,
    remote: "read",
    handle: ({ response, context, params }) => {
      context.agent(params.name);
      json(
        response,
        db
          .prepare(
            "select thread, count(*) as messages, max(at) as last from messages where thread like ? group by thread order by last desc limit 20",
          )
          .all(`${params.name}/%`),
      );
    },
  },
  {
    method: "GET",
    path: "/api/runs",
    does: "Every agent's runs, newest first. Takes ?agent= and ?limit=.",
    token: true,
    remote: "read",
    handle: ({ response, url }) => {
      const agent = url.searchParams.get("agent");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      json(
        response,
        agent
          ? db.prepare(`select ${RUN_COLUMNS} from runs where agent = ? order by started desc limit ?`).all(agent, limit)
          : db.prepare(`select ${RUN_COLUMNS} from runs order by started desc limit ?`).all(limit),
      );
    },
  },
  {
    method: "GET",
    path: "/api/runs/:id",
    does: "One run in full, with every step it took and the commits it made.",
    token: true,
    remote: "read",
    handle: ({ response, params }) => {
      const row = db.prepare("select * from runs where id = ?").get(params.id) as { trace: string; commits: string | null } | undefined;
      if (!row) throw new NotFound("No run with that id.");
      json(response, { ...row, trace: JSON.parse(row.trace), commits: row.commits ? JSON.parse(row.commits) : [] });
    },
  },
  {
    method: "GET",
    path: "/api/threads/:thread",
    does: "What was said in one conversation.",
    token: true,
    remote: "read",
    handle: ({ response, params }) => json(response, recall(decodeURIComponent(params.thread), { limit: 100 })),
  },
  {
    method: "GET",
    path: "/api/parked",
    does: "Every job waiting on an answer. A question nobody answers is a job that never finishes.",
    token: true,
    remote: "read",
    handle: ({ response }) => json(response, parkedRuns()),
  },
  {
    method: "GET",
    path: "/api/recent-work",
    does: "What each agent has done lately, as its own jobs record it.",
    token: true,
    remote: "read",
    handle: ({ response, context }) =>
      json(response, Object.fromEntries([...context.agents().values()].map((a) => [a.name, recentWork(a)]))),
  },
  {
    method: "GET",
    path: "/api/health",
    does: "Which agents are loaded and which jobs are running right now.",
    token: true,
    remote: "read",
    handle: ({ response, context }) =>
      json(response, { ok: true, agents: [...context.agents().keys()], running: context.clock.running() }),
  },

  // Doing. A token may do these, and only to an agent that binds an api channel.
  {
    method: "POST",
    path: "/api/agents/:name/chat",
    does: "One turn with the agent. Send the same thread again and it remembers what was said.",
    takes: '{"prompt": "...", "thread": "a name of your own, optional", "model": "optional"}',
    token: true,
    needsApiChannel: true,
    remote: "chat",
    handle: async ({ request, response, context, params, who }) => {
      const agent = context.agent(params.name);
      const { prompt, thread, model } = await body(
        request,
        z.object({ prompt: z.string().trim().min(1), thread: z.string().optional(), model: z.string().optional() }),
      );
      // A token's threads are kept apart from the ones a person started, so two
      // callers cannot land in each other's conversation.
      const token = who?.kind === "token";
      const under = token && thread ? `${agent.name}/api-${thread}` : (thread ?? "");
      // The same path as every channel's message, so a /command or a message a
      // job answers goes to that job here too. Who may call this is already
      // settled by the login or the token, so there is no allowFrom.
      // Somebody signed in with a thread is the page's own chat, which the api
      // channel's settings are not for.
      const channel = !token && thread ? "chat" : channelOf(request);
      const handled = await receive(agent, {
        channel,
        chat: under,
        thread: under,
        from: token ? { id: who.token.id, name: who.token.name } : { id: "account", name: "the account" },
        text: prompt,
        private: true,
        model,
      }, { chatHistory: channel === "chat" ? undefined : agent.channels.find((one) => one.name === "api")?.chatHistory });
      json(response, handled);
    },
  },
  {
    method: "POST",
    path: "/api/agents/:name/model",
    does: 'Pick a model on the fly: for everything the agent does, one job, or one chat. An empty model takes the pick back.',
    takes: '{"scope": "agent" | "job:<id>" | "chat:<thread>", "model": "..." or ""}',
    remote: "write",
    handle: async ({ request, response, context, params }) => {
      const agent = context.agent(params.name);
      const { scope, model } = await body(
        request,
        z.object({ scope: z.string().regex(/^(agent|job:.+|chat:.+)$/, 'agent, job:<id> or chat:<thread>'), model: z.string().trim() }),
      );
      if (scope.startsWith("job:") && !agent.jobs.some((one) => one.id === scope.slice(4))) {
        throw new BadRequest(`${agent.name} has no job called ${scope.slice(4)}.`);
      }
      if (model && !models(agent).some((one) => one.model === model)) {
        throw new BadRequest(`${model} is not on offer here. GET /api/models lists what is.`);
      }
      choose(agent.name, scope as Scope, model);
      json(response, summary(agent));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:name/job/:job",
    does: "Run one of that agent's jobs now, rather than waiting for its cron line. Takes what that job's input shape says.",
    takes: 'whatever the job declares, as JSON or as a query string: {"text": "..."}',
    token: true,
    needsApiChannel: true,
    remote: "run",
    handle: async ({ request, response, context, params, url }) => {
      const agent = context.agent(params.name);
      const job = agent.jobs.find((one: Job) => one.id === params.job);
      if (!job) throw new NotFound(`${agent.name} has no job called ${JSON.stringify(params.job)}.`);

      // A query string for the one-liner case, a body for anything with
      // newlines or numbers in it, and the body wins where they overlap.
      // Everything in a query string is a string, so a job that wants a number
      // says z.coerce.number().
      const sent = {
        ...Object.fromEntries(url.searchParams),
        ...(await body(request, z.record(z.string(), z.unknown()))),
      };

      // Checked here rather than left to the run, because the run is started
      // and not awaited: a caller that sent the wrong thing would otherwise get
      // "started" and have to go and read a failed run to find out it was not.
      try {
        checkInput(job, sent);
      } catch (error) {
        return json(response, { error: (error as Error).message }, 400);
      }

      void context.clock.fire(agent, job, sent, channelOf(request));
      json(response, { started: `${agent.name}/${job.id}`, log: `/api/agents/${agent.name}/log` });
    },
  },

  // Writing, and the tokens themselves. The account and nothing else.
  {
    method: "POST",
    path: "/api/agents/:name/file",
    does: "Write a file in that agent's folder back. Markdown only: code is edited where the type checker runs.",
    takes: '{"path": "skills/x.md", "content": "..."}',
    remote: "write",
    handle: async ({ request, response, context, params }) => {
      context.agent(params.name);
      const { path, content } = await body(request, z.object({ path: z.string(), content: z.string() }));
      if (!editable(path)) {
        return json(response, { error: `${path} is not markdown, so it cannot be written from here.` }, 400);
      }
      json(response, await save(params.name, path, content));
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/answer",
    does: "Answer a job that stopped to ask something, from here rather than on the channel it asked on.",
    takes: '{"text": "..."}',
    remote: "write",
    handle: async ({ request, response, context, params }) => {
      const { text } = await body(request, z.object({ text: z.string().trim().min(1) }));
      json(response, await answer(params.id, text, context.agents()));
    },
  },
  {
    method: "POST",
    path: "/api/threads/:thread/forget",
    does: "Forget one conversation.",
    remote: "write",
    handle: ({ response, params }) => {
      forget(decodeURIComponent(params.thread));
      json(response, { forgotten: decodeURIComponent(params.thread) });
    },
  },
  {
    method: "GET",
    path: "/api/tokens",
    does: "Every token, revoked ones included. Never the secrets: they were not kept.",
    handle: ({ response }) => json(response, tokens()),
  },
  {
    method: "POST",
    path: "/api/tokens",
    does: "Make a token. The only time the secret exists in one piece is in this reply.",
    takes: '{"name": "what it is for"}',
    handle: async ({ request, response }) => {
      const { name } = await body(request, z.object({ name: z.string().trim().min(1) }));
      const { secret, token } = makeToken(name);
      json(response, { ...token, secret });
    },
  },
  {
    method: "POST",
    path: "/api/tokens/:id/revoke",
    does: "Stop a token working, now.",
    handle: ({ response, params }) => json(response, revokeToken(params.id)),
  },

  // Where an agent remembers things. Every agent has one, and none of these
  // takes a token: see memory.ts for why every read is written down first.
  {
    method: "GET",
    path: "/api/agents/:name/memory",
    does: "That agent's memory as a tree. Empty when it has never written anything. Recorded like a read.",
    remote: "memory",
    handle: async ({ request, response, context, params }) =>
      json(response, await memoryTree(context.agent(params.name), from(request))),
  },
  {
    method: "GET",
    path: "/api/agents/:name/memory/file",
    does: "One file as text, for editing. Takes ?path=. Written to the audit log before it is sent.",
    remote: "memory",
    handle: async ({ request, response, context, params, url }) => {
      const path = url.searchParams.get("path");
      if (!path) return json(response, { error: "No path." }, 400);
      const found = await memoryOpen(context.agent(params.name), path, from(request));
      if (!found) throw new NotFound(`Nothing at ${path}.`);
      json(response, found);
    },
  },
  {
    method: "POST",
    path: "/api/agents/:name/memory/file",
    does: "Write a file back. A commit too, when the memory is a repo and the agent says to commit.",
    takes: '{"path": "01_projects/x.html", "content": "..."}',
    remote: ["memory", "write"],
    handle: async ({ request, response, context, params }) => {
      const { path, content } = await body(request, z.object({ path: z.string(), content: z.string() }));
      json(response, await memorySave(context.agent(params.name), path, content, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:name/memory/rename",
    does: "Move a file or a folder inside that memory.",
    takes: '{"from": "a.html", "to": "b/a.html"}',
    remote: ["memory", "write"],
    handle: async ({ request, response, context, params }) => {
      const moved = await body(request, z.object({ from: z.string().min(1), to: z.string().min(1) }));
      json(response, await memoryRename(context.agent(params.name), moved.from, moved.to, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:name/memory/delete",
    does: "Delete a file or a folder. In a repo, git still has it.",
    takes: '{"path": "a.html"}',
    remote: ["memory", "write"],
    handle: async ({ request, response, context, params }) => {
      const { path } = await body(request, z.object({ path: z.string().min(1) }));
      json(response, await memoryDelete(context.agent(params.name), path, from(request)));
    },
  },
  {
    method: "GET",
    path: "/api/agents/:name/memory/pass",
    does: "A pass to show that memory's files in a frame, for ten minutes. See pass.ts.",
    remote: "memory",
    handle: ({ response, context, params }) => {
      const pass = makePass(context.agent(params.name).name);
      json(response, { pass, at: `/memory/${encodeURIComponent(pass)}` });
    },
  },
  {
    method: "GET",
    path: "/api/agents/:name/memory/log",
    does: "That agent's audit log: every file read, served, written, moved or deleted, when, and from where.",
    remote: "memory",
    handle: async ({ response, context, params, url }) =>
      json(
        response,
        await memoryLog(context.agent(params.name), Math.min(Number(url.searchParams.get("limit") ?? 200), 1000)),
      ),
  },
  {
    method: "GET",
    path: "/api/agents/:name/memory/git",
    does: "Source control for that memory, when it is a repo: what changed, the branch, and the recent history.",
    remote: "memory",
    handle: async ({ response, context, params }) => json(response, await memoryGit(context.agent(params.name))),
  },
  {
    method: "POST",
    path: "/api/agents/:name/memory/git/commit",
    does: "Commit everything that changed in that memory.",
    takes: '{"message": "..."}',
    remote: ["memory", "write"],
    handle: async ({ request, response, context, params }) => {
      const { message } = await body(request, z.object({ message: z.string() }));
      json(response, await memoryCommit(context.agent(params.name), message, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:name/memory/git/push",
    does: "Push that memory's commits. Says where they went, because this is what sends them off the box.",
    remote: ["memory", "write"],
    handle: async ({ request, response, context, params }) =>
      json(response, await memoryPush(context.agent(params.name), from(request))),
  },
  {
    method: "POST",
    path: "/api/agents/:name/memory/git/pull",
    does: "Pull, fast-forward only.",
    remote: ["memory", "write"],
    handle: async ({ request, response, context, params }) =>
      json(response, await memoryPull(context.agent(params.name), from(request))),
  },

  // What an agent changed: the commits in its memory and in its own folder.
  // A memory's are recorded like any read of it, so none of these takes a token.
  {
    method: "GET",
    path: "/api/agents/:name/changes",
    does: "Commits to that agent's memory and own folder, newest first, the ones it made since somebody last looked marked new. Takes ?in=memory|folder, ?path= for one file's history, and ?limit=, at most 200.",
    remote: "memory",
    handle: async ({ request, response, context, params, url }) =>
      json(
        response,
        await agentChanges(
          context.agent(params.name),
          {
            place: placeOf(url.searchParams.get("in")),
            path: url.searchParams.get("path") || undefined,
            limit: Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200),
          },
          from(request),
        ),
      ),
  },
  {
    method: "GET",
    path: "/api/agents/:name/changes/:id",
    does: "One commit and its diff, cut to that agent's part of the repository. Takes ?in=memory|folder.",
    remote: "memory",
    handle: async ({ request, response, context, params, url }) => {
      const place = placeOf(url.searchParams.get("in"));
      if (!place) return json(response, { error: "Say which: ?in=memory or ?in=folder." }, 400);
      json(response, await agentChange(context.agent(params.name), place, params.id, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:name/changes/seen",
    does: "Everything that agent has changed up to now has been looked at.",
    remote: "write",
    handle: ({ response, context, params }) => json(response, agentSeen(context.agent(params.name))),
  },
  {
    method: "POST",
    path: "/api/agents/:name/changes/:id/undo",
    does: "Put every file one commit changed back how it was, and commit that. Refused when a file has changed since.",
    takes: '{"in": "memory"}',
    remote: ["memory", "write"],
    handle: async ({ request, response, context, params }) => {
      const { in: place } = await body(request, z.object({ in: z.enum(["memory", "folder"]) }));
      json(response, await agentUndo(context.agent(params.name), place, params.id, from(request)));
    },
  },
];

/** Signing in, and setting the password the first time. One body, two doors. */
async function wayIn({ request, response }: At, making: boolean): Promise<void> {
  const { password } = await body(request, z.object({ password: z.string() }));
  try {
    if (making) createAccount(password);
    // The same value twice: the cookie for a browser, and the body for
    // anything that is not one.
    const at = from(request);
    const token = signIn(password, at);
    signedInFrom(at);
    response.setHeader("set-cookie", setCookie(token, overHttps(request)));
    json(response, { ok: true, token });
  } catch (error) {
    json(response, { error: (error as Error).message }, 401);
  }
}

/** Every route as GET /api lists it: what it does, and who may call it. Sent to a cloud on connect too. */
export function routeList() {
  return routes.map((one) => ({
    method: one.method,
    path: one.path,
    does: one.does,
    takes: one.takes,
    who: one.open ? "anybody" : one.token ? "account or token" : "account",
    needsApiChannel: one.needsApiChannel || undefined,
    remote: one.remote,
  }));
}

/** The route whose path matches, with whatever its `:parts` caught. */
function match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  const parts = path.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const wanted = route.path.split("/").filter(Boolean);
    if (wanted.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let at = 0; at < wanted.length; at++) {
      if (wanted[at].startsWith(":")) params[wanted[at].slice(1)] = parts[at];
      else if (wanted[at] !== parts[at]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
}

export function serve(options: {
  host: string;
  port: number;
  agents: () => Map<string, Agent>;
  clock: Clock;
  /** What the running channels answer, asked again on every request because a channel can start or stop. */
  channels: () => ChannelRoute[];
}) {
  const context: Context = {
    agents: options.agents,
    agent(name) {
      const found = options.agents().get(name);
      if (!found) throw new NotFound(`There is no agent called ${JSON.stringify(name)}.`);
      return found;
    },
    clock: options.clock,
    body,
    json,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      const channel = request.method === "POST" ? options.channels().find((one) => one.path === path) : undefined;
      if (channel) return await channel.handle(request, response);
      if (path === "/api" || path.startsWith("/api/")) return await api(request, response, path, url, context);
      if (path.startsWith("/memory/") && request.method === "GET") return await framed(request, response, url, context);
      await sitePage(request, response, path, context);
    } catch (error) {
      if (error instanceof NotFound) return json(response, { error: error.message }, 404);
      if (error instanceof BadRequest) return json(response, { error: error.message }, 400);
      console.error(`${request.method} ${path}:`, error);
      json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  server.listen(options.port, options.host);
  return server;
}

/**
 * A memory file, for the frame it is shown in: `/memory/<pass>/<path>`.
 *
 * The pass says whose memory and that it is still good, and it is the only
 * thing that does: no cookie is looked at. That is deliberate, because the
 * document is sandboxed and its own requests carry no cookie anyway.
 *
 * The headers are the security of the whole viewer, so each earns its line:
 *
 *   sandbox allow-scripts   the file runs its own script, in an origin of its
 *                           own. It cannot touch the page around it, and it
 *                           cannot call the API as the person signed in, even
 *                           opened on its own in a tab. Without this, a note an
 *                           agent wrote from somebody's email could make a
 *                           token and walk off with the account.
 *   allow-popups...         so a link in a note still opens.
 *   connect-src 'none'      no fetch, no XHR, no socket: a script can read the
 *                           pass in its own address, but cannot send it
 *                           anywhere.
 *   img-src, style-src...   what the notes actually use, and only from here,
 *                           so an image cannot be a way out either.
 *   frame-ancestors 'self'  only this site may frame it.
 */
async function framed(request: IncomingMessage, response: ServerResponse, url: URL, context: Context): Promise<void> {
  const [, , raw = "", ...rest] = url.pathname.split("/");
  const pass = decodeURIComponent(raw);
  const whose = checkPass(pass);
  const refuse = (status: number, text: string): void =>
    void response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
  // A pass is made by a memory route, which through the cloud already needed
  // this switch. Checked again here, so turning it off stops the frame too.
  if (relayedBy(request) !== null && !settings.cloud.remote.memory) {
    return refuse(403, "This workspace does not allow memory through the cloud.");
  }
  if (!whose) return refuse(403, "This pass has run out. Open the file again.");
  const agent = context.agents().get(whose);
  if (!agent) return refuse(404, "Not here.");

  const path = rest.map(decodeURIComponent).join("/");
  // Through the dashboard the browser is under /workspaces/<name>, so that
  // is what a note's own links have to start with. Empty when nobody relayed.
  const found = await memoryRaw(agent, path, from(request), `${relayUnder(request)}/memory/${raw}`);
  if (!found) return refuse(404, "Not here.");

  const here = `${overHttps(request) ? "https" : "http"}://${request.headers.host ?? "localhost"}`;
  // 'self' and the site's own origin both, because what 'self' means for a
  // sandboxed document is the one thing browsers have not always agreed on.
  const own = `'self' ${here}`;
  response.writeHead(200, {
    "content-type": found.type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
      `default-src ${own}`,
      `script-src ${own} 'unsafe-inline' https://cdnjs.cloudflare.com`,
      `style-src ${own} 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${own} https://fonts.gstatic.com`,
      `img-src ${own} data:`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  });
  response.end(found.body);
}

/**
 * One API call: find the route, work out whether this caller may have it, and
 * hand it over. The whole of the authorisation is here, so there is one place
 * to read rather than one check per handler.
 */
async function api(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
  context: Context,
): Promise<void> {
  const found = match(request.method ?? "GET", path);
  if (!found) throw new NotFound(`No route for ${request.method} ${path}. GET /api lists them.`);
  const { route, params } = found;

  const who = caller(request);
  // Through the dashboard: only the routes that say so, and only the switches
  // this workspace has on. The open routes are not open to it either, so a
  // fresh runtime's setup form cannot be filled in from the cloud.
  if (who?.kind === "cloud") {
    if (!route.remote) return json(response, { error: "Not through the cloud: that is done on the box itself." }, 403);
    const off = [route.remote].flat().filter((one) => !settings.cloud.remote[one]);
    if (off.length) {
      return json(
        response,
        { error: `This workspace does not allow ${off.join(" and ")} through the cloud. cloud.remote in its settings.json switches it on.` },
        403,
      );
    }
  }
  if (!route.open) {
    if (!who) return json(response, { error: "Sign in first." }, 401);
    if (who.kind === "token" && !route.token) {
      return json(response, { error: "A token cannot do that. That one is the account's." }, 403);
    }
    if (who.kind === "token" && route.needsApiChannel && !onTheApi(context.agent(params.name))) {
      return json(
        response,
        { error: `${params.name} has no api channel, so a token cannot reach it. Bind one to open it.` },
        403,
      );
    }
  }

  await route.handle({ request, response, url, params, context, who });
}

export function json(response: ServerResponse, value: unknown, status = 200): void {
  const text = JSON.stringify(value, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(text);
}

export function html(response: ServerResponse, value: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(value);
}

/**
 * A request's JSON, in the shape the route says it takes, or a 400 saying
 * what did not fit. Capped, so a bad caller cannot fill memory.
 */
export async function body<Shape extends z.ZodType>(request: IncomingMessage, shape: Shape): Promise<z.infer<Shape>> {
  const text = await new Promise<string>((done, fail) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk;
      if (text.length > 1_000_000) {
        fail(new BadRequest("Body too large."));
        request.destroy();
      }
    });
    request.on("end", () => done(text));
    request.on("error", fail);
  });
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new BadRequest("Body is not valid JSON.");
  }
  const checked = shape.safeParse(value);
  if (!checked.success) {
    throw new BadRequest(checked.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; "));
  }
  return checked.data;
}

// Where a route author is already looking, so throwing one does not need a
// second import.
export { BadRequest, NotFound };
