// Every route is in this file, so what is reachable from outside is this file
// and nothing else, plus whatever paths a running channel answers. It binds
// `serve.host` in settings, loopback unless somebody says otherwise. Every
// address that is not /api is the page: an installed one, or the runtime's own
// (see page.ts).
//
// The routes are a list rather than a run of ifs, because the docs at GET /api
// are generated from that list. A route nobody wrote down is a route nobody
// documented, and a documented route that does not exist is worse than either.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createServer as createPortHolder, type Server as PortHolder, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

import { z } from "zod";

import { db, RUN_COLUMNS } from "#chloe/core/db";
import { readEnvFile, writeEnv } from "#chloe/core/env";
import { ROUTES, settings } from "#chloe/core/settings";
import { hasChannel, type Agent, type ChannelRoute, type Job } from "#chloe/load/load";
import { tryJob, type Clock } from "#chloe/core/clock";
import { PURPOSE_HERE, alwaysOnTools, ownerPrompt } from "#chloe/core/turn";
import { choices, choose, modelFor, type Scope } from "#chloe/model/choices";
import { commands } from "#chloe/channels/shared";
import { current, forget } from "#chloe/model/memory";
import { models } from "#chloe/model/model";
import { nameThread } from "#chloe/model/naming";
import { agentChange, agentChanges, agentSeen, agentUndo, placeOf } from "./changes.ts";
import { changeChannel, changeAbility, changeSettings, changeTool, configFields, configText, InCode, keysUsed, saveConfig } from "./config.ts";
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
import type { Certificate } from "./certificate.ts";
import { checkPass, makePass } from "./pass.ts";
import { BadRequest, NotFound, Refused } from "./errors.ts";
import { channelsOf, connectionsOf, abilityNames, abilitiesOf, signInOf, toolsOf } from "./inside.ts";
import { describe } from "#chloe/timer/every";
import {
  type Caller,
  caller,
  changeAccount,
  firstPassword,
  from,
  memberSession,
  hasName,
  hasPassword,
  overHttps,
  ownName,
  setCookie,
  signIn,
  signInMember,
  signInWithLink,
} from "./login.ts";
import { accept, change, invitation, invite, people, remove, SWITCHES, type Given, type Switch } from "./people.ts";
import { makeToken, revokeToken, tokens } from "./tokens.ts";
import { signedInFrom } from "#chloe/core/alerts";
import { PLUGINS } from "#chloe/plugins/index";
import { providers } from "#chloe/services/emailService";
import { servePage } from "./page.ts";
import { elsewhere, framedElsewhere, listsElsewhere, passOn, runningElsewhere, summariesElsewhere, whereElse } from "./elsewhere.ts";
import { receive } from "#chloe/channels/shared";
import { answer, checkArgs, parkedRuns, type ParkedRun } from "#chloe/core/steps";
import { canCarryOn, stopReply, stopped } from "#chloe/core/turn";

/**
 * The address a program on this machine reaches the port at: `serve.host` and
 * `serve.port` in settings, with loopback in place of a host that means every
 * address, because "0.0.0.0" is somewhere to listen and not somewhere to call.
 */
export function ownAddress(): string {
  const { host, port } = settings.serve;
  const reach = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  return `http://${reach.includes(":") ? `[${reach}]` : reach}:${port}`;
}

/**
 * The address another computer opens the page at under `npx chloe --remote`:
 * the one this SSH session came in on, which the person's own computer can
 * reach, or else this machine's first address that is not loopback.
 */
export function remoteAddress(): string {
  const reach =
    process.env.SSH_CONNECTION?.split(" ")[2] ||
    Object.values(networkInterfaces())
      .flat()
      .find((one) => one && !one.internal && one.family === "IPv4")?.address ||
    "127.0.0.1";
  return `https://${reach.includes(":") ? `[${reach}]` : reach}:${settings.serve.port}`;
}

export interface Context {
  agent(id: string): Agent;
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
 *   path             like `/api/agents/:id/log`. A `:part` matches one segment.
 *   open             answered without a session or a token.
 *   token            a token may call it. Without this, only the account may.
 *   needsApiChannel  for a token, only when that agent binds an api channel.
 *   member            what somebody the owner invited needs on the agent the
 *                    path names: "chat", "read" or "run". "filtered" on a
 *                    route whose handler answers them only what they may see.
 *                    Without it, the route is never theirs: everything that
 *                    changes something, and everything that is no agent's.
 *   origins          the sites whose pages may call it from a browser. Asked
 *                    first (OPTIONS), and checked on the call itself, which
 *                    is refused from any other. A route without it answers
 *                    no page on another site.
 */
export interface Route {
  method: "GET" | "POST";
  path: string;
  does: string;
  takes?: string;
  open?: boolean;
  token?: boolean;
  needsApiChannel?: boolean;
  member?: Switch | "filtered";
  origins?(at: Pick<At, "params" | "context">): string[];
  /** The headers a page on one of `origins` may send, besides content-type. */
  headers?: string[];
  handle(at: At): Promise<void> | void;
}

/** Whether this caller may see that agent at all: anybody but a member who was not let in to it. */
function sees(who: Caller, agent: string): boolean {
  return who?.kind !== "member" || Object.hasOwn(who.given, agent);
}

/** Whether this caller may have `what` on that agent: always, unless it is a member who was not given it. */
function may(who: Caller, agent: string, what: Switch): boolean {
  return who?.kind !== "member" || (who.given[agent] ?? []).includes(what);
}

/** The agents a member may read the runs of, or null for anybody who is not a member. */
function readable(who: Caller): string[] | null {
  if (who?.kind !== "member") return null;
  return Object.keys(who.given).filter((agent) => may(who, agent, "read"));
}

/**
 * The email a member's runs are under, or null for anybody who is not a member.
 * A turn's owner is "<channel>:<who wrote>", and a member writes as their email.
 */
function memberOf(who: Caller): string | null {
  return who?.kind === "member" ? who.email : null;
}

/** The part of a run's owner after its channel, lowercased: a member's email. */
const OWNED_BY = "lower(substr(owner, instr(owner, ':') + 1))";

/**
 * The conversation, when this caller may have it. A member's are the ones whose
 * owner is their email, and with `claim` one nobody has said anything in
 * becomes theirs. Anybody else may have any. One that is not theirs is
 * answered as if it did not exist.
 */
function threadFor(who: Caller, thread: string, claim = false): string {
  if (who?.kind !== "member") return thread;
  if (claim && !db.prepare("select 1 from messages where thread = ? limit 1").get(thread)) {
    db.prepare("insert into threads (thread, owner) values (?, ?) on conflict (thread) do nothing").run(thread, who.email);
  }
  const row = db.prepare("select owner from threads where thread = ?").get(thread) as { owner: string | null } | undefined;
  if (row?.owner !== who.email) throw new NotFound("No such conversation.");
  return thread;
}

/**
 * Where the chat route keeps a caller's conversation: a token's apart from the
 * ones a person started, and a member's only when it is theirs (`claim` makes
 * an unused one theirs). Empty for the account's chat with no thread.
 */
function chatThread(agent: string, thread: string | undefined, who: Caller, claim = false): string {
  if (who?.kind === "token") return thread ? `${agent}/api-${thread}` : "";
  if (who?.kind === "member") return threadFor(who, `${agent}/${thread ? thread.slice(thread.indexOf("/") + 1) : randomUUID()}`, claim);
  return thread ?? "";
}

/** Names a conversation, or with an empty label gives it back the name it started with. */
function label(thread: string, label: string): void {
  db.prepare("insert into threads (thread, label) values (?, ?) on conflict (thread) do update set label = excluded.label").run(thread, label || null);
}

/** Why a member may not have this route, or nothing when they may. */
function refusedMember(route: Route, params: Record<string, string>, given: Given): string | undefined {
  if (route.member === "filtered") return undefined;
  if (!route.member || !params.id) return "That is the owner's.";
  const theirs = given[params.id];
  if (!theirs) return `There is no agent called ${JSON.stringify(params.id)}.`;
  return theirs.includes(route.member) ? undefined : `You have not been given ${route.member} on ${params.id}. Its owner can allow it.`;
}

/** Runs from this copy and others as one list: each once, newest first. */
function newestFirst<Row extends { id: string; started: string }>(rows: Row[]): Row[] {
  const once = new Map<string, Row>();
  for (const row of rows) if (!once.has(row.id)) once.set(row.id, row);
  return [...once.values()].sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
}

/** The most pictures one chat turn takes. */
const PICTURES = 4;

/** A picture sent with a chat turn, as base64. Only the kinds every model route reads. */
export const Picture = z.object({
  name: z.string().trim().min(1).max(200),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(1),
});

/** Whether an agent has opted in to being reached by another system. */
function onTheApi(agent: Agent): boolean {
  return hasChannel(agent, "api");
}

/**
 * What this copy runs in when it is a machine of its own (`machine.own`): a
 * container when the container's maker left its mark (podman's
 * /run/.containerenv, docker's /.dockerenv), a virtual machine when not.
 * Undefined on a shared computer. The setting is the machine plugin's, so it is
 * missing with that plugin out.
 */
function machineKind(): "container" | "virtual machine" | undefined {
  if (!(settings.machine as { own?: boolean }).own) return undefined;
  return existsSync("/run/.containerenv") || existsSync("/.dockerenv") ? "container" : "virtual machine";
}

/** One agent's configuration, the same shape from the list and from its own route. */
export function summary(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    identity: agent.identity,
    /** What this copy runs in, when it is a machine of its own. */
    machine: machineKind(),
    /** What its runs go to. */
    model: modelFor(agent),
    /** What its definition names. */
    declaredModel: agent.model,
    /** Every choice made on the fly: for one job, or for one chat. */
    chosen: choices(agent.id),
    channels: agent.channels.map((one) => one.name).sort(),
    /** Whether a token may chat to it or run its jobs. */
    api: onTheApi(agent),
    /** What the site calls its memory. Every agent has one. */
    memory: memoryLabel(agent),
    tools: Object.keys(agent.tools ?? {}).sort(),
    /** What the page calls each tool that has a title of its own. */
    titles: Object.fromEntries(
      [...alwaysOnTools(agent).map((one) => [one.name, one.tool] as const), ...Object.entries(agent.tools ?? {})].flatMap(([name, one]) =>
        (one as { title?: string }).title ? [[name, (one as { title: string }).title]] : [],
      ),
    ),
    /** Every ability, and whether it is on. */
    abilities: abilityNames(agent),
    /** Where each tool it did not write itself comes from, like "abilities.memory". */
    toolsFrom: agent.toolsFrom ?? {},
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
      // The channels that hand it every message, for a job only they start.
      channels: s.channels,
      files: s.files,
    })),
  };
}

/**
 * What the log says a run came in on. `npm run agent` comes in over the API
 * and says so in a header, so the log can tell a person at a terminal from
 * another system holding a token. Anything else is "api".
 */
const CHANNELS = ["terminal"];

function channelOf(request: IncomingMessage): string {
  const said = request.headers["x-chloe-channel"];
  return typeof said === "string" && CHANNELS.includes(said) ? said : "api";
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api",
    does: "This list: every route, what it does and who may call it.",
    open: true,
    member: "filtered",
    handle: async ({ request, response }) => {
      // A browser gets the page, which shows this list. Anything else gets it as JSON.
      if ((request.headers.accept ?? "").includes("text/html")) return void (await servePage(response, "/api"));
      json(response, routeList());
    },
  },

  // The ways in. Asking whether there is a password, signing in and signing
  // out are the whole of what is answered without a session, and each says as
  // little as it can.
  {
    method: "GET",
    path: "/api/account",
    does: "Whether this copy has a password yet, and whether signing in asks for a name too, so a page knows what to ask for.",
    open: true,
    handle: ({ response }) => json(response, { exists: hasPassword(), named: hasName() }),
  },
  {
    method: "POST",
    path: "/api/login",
    does: "Sign in. Sets the cookie, and hands back the same value for anything that is not a browser. With an email, as somebody the owner invited.",
    takes: '{"password": "...", "name": "when the owner chose one", "email": "only for somebody invited"}',
    open: true,
    handle: async (at) => {
      const { password, name, email } = await body(
        at.request,
        z.object({ password: z.string(), name: z.string().optional(), email: z.string().trim().optional() }),
      );
      if (email) return wayIn(at, () => signInMember(email, password, from(at.request)), false);
      wayIn(at, () => signIn(password, from(at.request), name));
    },
  },
  {
    method: "POST",
    path: "/api/link",
    does: "Sign in with the code from a link that npx chloe link or the server's start printed. Each works once, within the hour.",
    takes: '{"code": "..."}',
    open: true,
    handle: async (at) => {
      const { code } = await body(at.request, z.object({ code: z.string() }));
      wayIn(at, () => signInWithLink(code, from(at.request)));
    },
  },
  {
    method: "POST",
    path: "/api/setup",
    does: "Set the first password, from a browser already signed in. Refused once one is set: change it with /api/account/change.",
    takes: '{"password": "..."}',
    handle: async ({ request, response }) => {
      const { password } = await body(request, z.object({ password: z.string() }));
      try {
        firstPassword(password);
        json(response, { ok: true });
      } catch (error) {
        json(response, { error: (error as Error).message }, 400);
      }
    },
  },
  {
    method: "GET",
    path: "/api/account/name",
    does: "The owner's name, which signing in asks for, or \"\" when there is none.",
    handle: ({ response }) => json(response, { name: ownName() }),
  },
  {
    method: "POST",
    path: "/api/account/change",
    does: "Change the owner's password, name or both, given the current password. A new password signs every other browser out; this one gets a new cookie.",
    takes: '{"current": "...", "password": "the new one", "name": "\"\" takes it away"}',
    handle: async ({ request, response }) => {
      const change = await body(request, z.object({ current: z.string(), password: z.string().optional(), name: z.string().optional() }));
      try {
        const token = changeAccount(change.current, { password: change.password, name: change.name });
        response.setHeader("set-cookie", setCookie(token, overHttps(request)));
        json(response, { ok: true });
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
    },
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
    does: "204 when the account is signed in, 401 when not. For a proxy deciding whether to let a visitor through to a site of its own.",
    handle: ({ response }) => {
      response.writeHead(204).end();
    },
  },
  {
    method: "GET",
    path: "/api/me",
    does: "Who is signed in: the owner, or somebody invited, with their email, their name and what they were given on each agent.",
    member: "filtered",
    handle: ({ response, who }) =>
      json(response, who?.kind === "member" ? { owner: false, email: who.email, name: who.name, given: who.given } : { owner: true }),
  },

  // The people the owner invites (people.ts). Inviting, changing and removing
  // are the owner's; an invitation is read and taken by whoever holds its code.
  {
    method: "GET",
    path: "/api/people",
    does: "Everybody invited to an agent, with what each may do there, and the invitations nobody has used yet.",
    handle: ({ response }) => json(response, people()),
  },
  {
    method: "POST",
    path: "/api/people",
    does: `Invite somebody to one agent. Hands back the code of a link to send them, once: nothing is sent from here. What they may do is any of ${SWITCHES.join(", ")}.`,
    takes: '{"email": "...", "name": "optional", "agent": "...", "given": ["chat"]}',
    handle: async ({ request, response, context }) => {
      const asked = await body(
        request,
        z.object({ email: z.string(), name: z.string().default(""), agent: z.string(), given: z.array(z.string()).default(["chat"]) }),
      );
      context.agent(asked.agent);
      try {
        const code = invite(asked.email, asked.name, asked.agent, asked.given);
        json(response, { code, path: `/invitation/${code}` });
      } catch (error) {
        json(response, { error: (error as Error).message }, 400);
      }
    },
  },
  {
    method: "POST",
    path: "/api/people/change",
    does: "Change what somebody may do on one agent, whether they are in or still invited.",
    takes: '{"email": "...", "agent": "...", "given": ["chat", "read"]}',
    handle: async ({ request, response }) => {
      const { email, agent, given } = await body(request, z.object({ email: z.string(), agent: z.string(), given: z.array(z.string()) }));
      change(email, agent, given);
      json(response, people());
    },
  },
  {
    method: "POST",
    path: "/api/people/remove",
    does: "Take somebody off one agent, at once. Off their last one, they are removed and signed out. An open invitation to it stops working.",
    takes: '{"email": "...", "agent": "..."}',
    handle: async ({ request, response }) => {
      const { email, agent } = await body(request, z.object({ email: z.string(), agent: z.string() }));
      remove(email, agent);
      json(response, people());
    },
  },
  {
    method: "GET",
    path: "/api/invitations/:code",
    does: "What an invitation is for, so its page can say so: the address, the agent, what it gives, and whether that address already has a password here. A 404 once it is used or out of date.",
    open: true,
    handle: ({ response, params, context }) => {
      const found = invitation(params.code);
      if (!found) return json(response, { error: "That invitation is used, out of date, or was never made." }, 404);
      json(response, { ...found, agentName: context.agents().get(found.agent)?.name ?? found.agent });
    },
  },
  {
    method: "POST",
    path: "/api/invitations/:code/accept",
    does: "Take an invitation and sign in. Somebody new chooses their password here; somebody already invited to another agent gives the one they have.",
    takes: '{"password": "...", "name": "optional"}',
    open: true,
    handle: async (at) => {
      const { password, name } = await body(at.request, z.object({ password: z.string(), name: z.string().default("") }));
      wayIn(at, () => memberSession(accept(at.params.code, password, name)), false);
    },
  },
  // Reading. A token may do all of this.
  {
    method: "GET",
    path: "/api/agents",
    does: "Every agent that is loaded, with its configuration. The owner also gets those that run elsewhere (serve.elsewhere), as their own copy says, with that copy's address as elsewhere.",
    token: true,
    member: "filtered",
    handle: async ({ request, response, context, who }) =>
      json(response, [
        ...[...context.agents().values()].filter((one) => sees(who, one.id)).map(summary),
        ...(who?.kind === "account" ? await summariesElsewhere(request) : []),
      ]),
  },
  {
    method: "GET",
    path: "/api/agents/:id",
    does: "One agent's configuration: its model, tools, skills, channels and jobs.",
    token: true,
    member: "filtered",
    handle: ({ response, context, params, who }) => {
      if (!sees(who, params.id)) throw new NotFound(`There is no agent called ${JSON.stringify(params.id)}.`);
      json(response, summary(context.agent(params.id)));
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/purpose",
    does: "What it is told to do, as the model is given it, and which file it is in when it is in one.",
    token: true,
    handle: ({ response, context, params }) => {
      const agent = context.agent(params.id);
      return json(response, { text: agent.purpose, path: agent.purposeFile });
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/prompt",
    does: `Everything it is told before a conversation starts, as a reply to its owner on the dashboard begins: what the runtime adds, with ${PURPOSE_HERE} where its purpose goes (GET /api/agents/:id/purpose is that).`,
    token: true,
    handle: async ({ response, context, params }) => json(response, { text: await ownerPrompt(context.agent(params.id), PURPOSE_HERE), purpose: PURPOSE_HERE }),
  },
  {
    method: "GET",
    path: "/api/agents/:id/skills",
    does: "Its skills, each with what it says. A skill is words it reaches for when it needs them.",
    token: true,
    handle: ({ response, context, params }) =>
      json(
        response,
        context
          .agent(params.id)
          .skills.map((one) => ({ name: one.name, description: one.description, body: one.body, path: one.file })),
      ),
  },
  {
    method: "GET",
    path: "/api/agents/:id/tools",
    does: "What it can do: every tool it is bound, with what the model is told each one is for, what it takes, and where it comes from.",
    token: true,
    handle: async ({ response, context, params }) => json(response, await toolsOf(context.agent(params.id))),
  },
  {
    method: "GET",
    path: "/api/agents/:id/abilities",
    does: "Every ability, whether it is on for this agent, what it does and the tools it adds.",
    token: true,
    handle: async ({ response, context, params }) => json(response, await abilitiesOf(context.agent(params.id))),
  },
  {
    method: "POST",
    path: "/api/agents/:id/abilities",
    does: "Switch one of its abilities on or off, in its agent.ts. Hands back every ability and tool as the agent now loads.",
    takes: '{"name": "memory", "on": true} or {"name": "email", "set": {"days": 3, "reply": true}}, a field set to null takes it out',
    handle: async ({ request, response, context, params }) => {
      const agent = context.agent(params.id);
      const change = await body(request, z.object({ name: z.string(), on: z.boolean().optional(), set: z.record(z.string(), z.unknown()).optional() }));
      try {
        // From the agent as it now loads: the server's own reload comes a moment later.
        const now = await changeAbility(agent, change.name, change);
        json(response, { abilities: await abilitiesOf(now), tools: await toolsOf(now) });
      } catch (error) {
        if (error instanceof NotFound || error instanceof BadRequest) throw error;
        throw new BadRequest((error as Error).message);
      }
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/tools",
    does: "Switch one tool off or on, in the without list of its agent.ts. Hands back every ability and tool as the agent now loads.",
    takes: '{"name": "memoryEditFile", "on": false}',
    handle: async ({ request, response, context, params }) => {
      const agent = context.agent(params.id);
      const { name, on } = await body(request, z.object({ name: z.string(), on: z.boolean() }));
      try {
        const now = await changeTool(agent, name, on);
        json(response, { abilities: await abilitiesOf(now), tools: await toolsOf(now) });
      } catch (error) {
        if (error instanceof NotFound || error instanceof BadRequest) throw error;
        throw new BadRequest((error as Error).message);
      }
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/channels",
    does: "The ways in it binds, and which setting carries each one's credentials. Never the credentials.",
    token: true,
    handle: async ({ response, context, params }) => json(response, await channelsOf(context.agent(params.id))),
  },
  {
    method: "POST",
    path: "/api/agents/:id/channels",
    does: "Switch one of the channels chloe ships on or off, fill in its options, or give it its tokens, in the agent's agent.ts and settings. Hands back every channel as the agent now loads.",
    takes: '{"name": "telegram", "on": true, "set": {"allowFrom": [123456789]}, "secrets": {"telegram": "the bot token"}}',
    handle: async ({ request, response, context, params }) => {
      const agent = context.agent(params.id);
      const change = await body(
        request,
        z.object({ name: z.string(), on: z.boolean().optional(), set: z.record(z.string(), z.unknown()).optional(), secrets: z.record(z.string(), z.string()).optional() }),
      );
      try {
        json(response, await channelsOf(await changeChannel(agent, change.name, change)));
      } catch (error) {
        if (error instanceof NotFound || error instanceof BadRequest) throw error;
        throw new BadRequest((error as Error).message);
      }
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/connections",
    does: "What it can reach that is not on this box, and whether each is set up. Never the credentials.",
    token: true,
    handle: async ({ response, context, params }) => json(response, await connectionsOf(context.agent(params.id))),
  },
  // A person at the page signing in, the same three functions a chat uses, so
  // there is one sign-in and two places to start it.
  {
    method: "POST",
    path: "/api/agents/:id/connections/:name/sign-in",
    does: "Start the sign-in of one of its connections, and hand back what to tell the person and the link to open.",
    handle: async ({ response, context, params }) => json(response, await signInOf(context.agent(params.id), params.name).start()),
  },
  {
    method: "POST",
    path: "/api/agents/:id/connections/:name/finish",
    does: "Finish that sign-in with what the person got back: the code, or the address the browser landed on.",
    takes: '{"answer": "4/0A..."}',
    handle: async ({ request, response, context, params }) => {
      const { answer } = await body(request, z.object({ answer: z.string().trim().min(1) }));
      json(response, { said: await signInOf(context.agent(params.id), params.name).finish(answer) });
    },
  },
  {
    method: "GET",
    path: "/api/models",
    does: "The models somebody may pick, each with the route it goes by on this box. ?agent= adds what that agent and its jobs name.",
    token: true,
    member: "filtered",
    handle: ({ response, context, url, who }) => {
      const name = url.searchParams.get("agent");
      if (name && !sees(who, name)) throw new NotFound(`There is no agent called ${JSON.stringify(name)}.`);
      json(response, models(name ? context.agent(name) : undefined));
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/log",
    does: "That agent's runs, newest first. Takes ?limit=, at most 200. Somebody invited gets only their own.",
    token: true,
    member: "read",
    handle: ({ response, context, params, url, who }) => {
      context.agent(params.id);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const member = memberOf(who);
      json(
        response,
        db
          .prepare(`select ${RUN_COLUMNS} from runs where agent = ? and (? is null or ${OWNED_BY} = ?) order by started desc limit ?`)
          .all(params.id, member, member, limit),
      );
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/files",
    does: "That agent's own folder as a tree: its purpose, skills, scripts and jobs.",
    token: true,
    handle: async ({ response, context, params }) => {
      context.agent(params.id);
      json(response, await tree(params.id));
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/file",
    does: "One file in that folder. Takes ?path=, and a folder answers with what is in it.",
    token: true,
    handle: async ({ response, context, params, url }) => {
      context.agent(params.id);
      const path = url.searchParams.get("path");
      if (!path) return json(response, { error: "No path." }, 400);
      const found = await open(params.id, path);
      if (!found) throw new NotFound(`${params.id} has no ${path}.`);
      json(response, found);
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/threads",
    does: "That agent's conversations, newest first, however they were started. Somebody invited gets only their own.",
    token: true,
    member: "chat",
    handle: ({ response, context, params, who }) => {
      context.agent(params.id);
      const member = memberOf(who);
      const under = `${params.id}/`;
      const rows = db
        .prepare(
          `select m.thread, count(*) as messages, max(m.at) as last, t.label, t.archived, t.owner
           from messages m left join threads t on t.thread = m.thread
           where substr(m.thread, 1, ?) = ? and (? is null or t.owner = ?) group by m.thread order by last desc limit 50`,
        )
        .all(under.length, under, member, member) as { owner: string | null }[];
      // Every one a member sees is theirs, so whose it is would only be their own email.
      json(response, member ? rows.map(({ owner, ...rest }) => rest) : rows);
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/commands",
    does: "What a chat with that agent understands as a command: one per job, then /models and /clear. The same list Telegram is given.",
    token: true,
    handle: ({ response, context, params }) => json(response, commands(context.agent(params.id))),
  },
  {
    method: "GET",
    path: "/api/runs",
    does: "Every agent's runs, newest first. Takes ?agent= and ?limit=. Somebody invited gets only their own. The owner also gets the runs of agents that run elsewhere.",
    token: true,
    member: "filtered",
    handle: async ({ request, response, url, who }) => {
      const agent = url.searchParams.get("agent");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const only = readable(who);
      if (only) {
        const agents = agent ? only.filter((one) => one === agent) : only;
        if (!agents.length) return json(response, []);
        return json(
          response,
          db
            .prepare(`select ${RUN_COLUMNS} from runs where agent in (${agents.map(() => "?").join(", ")}) and ${OWNED_BY} = ? order by started desc limit ?`)
            .all(...agents, memberOf(who), limit),
        );
      }
      const here = (
        agent
          ? db.prepare(`select ${RUN_COLUMNS} from runs where agent = ? order by started desc limit ?`).all(agent, limit)
          : db.prepare(`select ${RUN_COLUMNS} from runs order by started desc limit ?`).all(limit)
      ) as { id: string; agent: string; started: string }[];
      if (who?.kind !== "account" || (agent && !elsewhere(agent))) return json(response, here);
      json(response, newestFirst([...here, ...(await listsElsewhere<{ id: string; agent: string; started: string }>(`/api/runs?limit=${limit}`, request, agent ?? undefined))]).slice(0, limit));
    },
  },
  {
    method: "GET",
    path: "/api/runs/:id",
    does: 'One run in full, with every step it took and the commits it made, and whether it can carry on: "cut off" when the service stopped it, "out of steps" when it ran out, false otherwise.',
    token: true,
    member: "filtered",
    handle: ({ response, params, who }) => {
      const row = db.prepare("select * from runs where id = ?").get(params.id) as
        | { agent: string; owner: string | null; trace: string; commits: string | null }
        | undefined;
      if (!row || !may(who, row.agent, "read")) throw new NotFound("No run with that id.");
      const member = memberOf(who);
      if (member) {
        // Their own turn, as they said it and as it was answered. The prompt,
        // the context and the steps carry the agent's purpose and what its
        // tools read, which are the owner's.
        if (row.owner?.slice(row.owner.indexOf(":") + 1).toLowerCase() !== member) throw new NotFound("No run with that id.");
        const { prompt, context, trace, state, args, input, parked, owner, ...rest } = row as Record<string, unknown>;
        return json(response, { ...rest, trace: [], commits: [], carryOn: false });
      }
      json(response, { ...row, trace: JSON.parse(row.trace), commits: row.commits ? JSON.parse(row.commits) : [], carryOn: canCarryOn(params.id) });
    },
  },
  {
    method: "GET",
    path: "/api/threads/:thread",
    does: "What was said in one conversation.",
    token: true,
    member: "filtered",
    handle: ({ response, params, who }) => {
      const thread = threadFor(who, decodeURIComponent(params.thread));
      if (!may(who, thread.split("/")[0], "chat")) throw new NotFound("No such conversation.");
      // Read here, not through recall(): that is what a model is shown, and it carries no time.
      const rows = db
        .prepare("select role, content, at from messages where thread = ? order by id desc limit 100")
        .all(thread) as { role: string; content: string; at: string }[];
      json(response, rows.reverse());
    },
  },
  {
    method: "GET",
    path: "/api/parked",
    does: "Every job waiting on an answer. A question nobody answers is a job that never finishes.",
    token: true,
    member: "filtered",
    handle: async ({ request, response, who }) => {
      const here = parkedRuns().filter((one) => may(who, one.agent, "read"));
      if (who?.kind !== "account") return json(response, here);
      const seen = new Set(here.map((one) => one.id));
      json(response, [...here, ...(await listsElsewhere<ParkedRun>("/api/parked", request)).filter((one) => !seen.has(one.id))]);
    },
  },
  {
    method: "GET",
    path: "/api/health",
    does: "Which agents are loaded and which jobs are running right now, those that run elsewhere included for the owner.",
    token: true,
    member: "filtered",
    handle: async ({ request, response, context, who }) => {
      const there = who?.kind === "account" ? await runningElsewhere(request) : { agents: [], running: [] };
      json(response, {
        ok: true,
        agents: [...[...context.agents().keys()].filter((one) => sees(who, one)), ...there.agents],
        running: [...context.clock.running().filter((one) => may(who, one.split("/")[0], "read")), ...there.running],
      });
    },
  },

  // Doing. A token may do these, and only to an agent that binds an api channel.
  {
    method: "POST",
    path: "/api/agents/:id/chat",
    does: "One turn with the agent. Send the same thread again and it remembers what was said. Pictures are seen in this turn only and never kept.",
    takes: '{"prompt": "...", "thread": "a name of your own, optional", "model": "optional", "images": [{"name": "...", "mediaType": "image/png", "data": "base64"}]}',
    token: true,
    needsApiChannel: true,
    member: "chat",
    handle: async ({ request, response, context, params, who }) => {
      const agent = context.agent(params.id);
      const { prompt, thread, model, images } = await body(
        request,
        z.object({
          prompt: z.string().trim(),
          thread: z.string().optional(),
          model: z.string().optional(),
          images: z.array(Picture).max(PICTURES).default([]),
        }),
        8 << 20,
      );
      if (!prompt && !images.length) throw new BadRequest("Say something, or send a picture.");
      // A token's threads are kept apart from the ones a person started, and
      // each member's from everybody else's, so two callers cannot land in each
      // other's conversation.
      const token = who?.kind === "token";
      const member = who?.kind === "member" ? who : undefined;
      if (member) {
        // Picking a model changes it for everybody, and a /command runs a job.
        if (/^\/models?(?:@\w+)?(?:\s|$)/i.test(prompt)) {
          return json(response, { error: "Only the owner picks the model." }, 403);
        }
        if (prompt.startsWith("/") && !/^\/clear(?:@\w+)?\s*$/i.test(prompt) && !may(member, agent.id, "run")) {
          return json(response, { error: `You have not been given run on ${agent.id}. Its owner can allow it.` }, 403);
        }
      }
      const under = chatThread(agent.id, thread, who, true);
      // The same path as every channel's message, so a /command, or a reply
      // that is one, goes to that job here too. Who may call this is already
      // settled by the login or the token, so there is no allowFrom.
      // Somebody signed in with a thread is the page's own chat, which the api
      // channel's settings are not for.
      const channel = !token && thread ? "chat" : channelOf(request);
      // A new conversation on the page is named while the agent answers, and
      // the answer waits a little for it, so the list has the name with it.
      const fresh = channel === "chat" && prompt && !prompt.startsWith("/") && !db.prepare("select 1 from messages where thread = ? limit 1").get(under);
      const naming = fresh ? nameThread(under, prompt) : undefined;
      const handled = await receive(agent, {
        channel,
        chat: under,
        thread: under,
        from: token ? { id: who.token.id, name: who.token.name } : member ? { id: member.email, name: member.name } : { id: "account", name: "the account" },
        // The page's chat says who wrote, the way a channel's message does, so
        // the agent and whoever reads the run can see it.
        context: channel === "chat" ? (member ? { address: member.email, role: "member" } : { role: "owner" }) : undefined,
        text: prompt,
        private: true,
        model: member ? undefined : model,
        // The account is the owner. A member or a token never is.
        fromOwner: !token && !member,
        mayChangeAgent: !token && !member,
        // Handed to the model for this turn and dropped: what is kept is the
        // line saying they were attached.
        files: images.length
          ? async () => ({
              attachments: images.map(({ name, mediaType, data }) => ({ mediaType, data, filename: name })),
              notes: images.map((one) => `(Attached: ${one.name})`),
            })
          : undefined,
      }, { chatHistory: channel === "chat" ? undefined : agent.channels.find((one) => one.name === "api")?.chatHistory });
      if (naming) await Promise.race([naming, new Promise((done) => setTimeout(done, 5000))]);
      json(response, handled);
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/chat/stop",
    does: "Stop the reply going in a conversation, by the thread the chat was sent with. Its chat call then answers with what stopped it.",
    takes: '{"thread": "..."}',
    token: true,
    needsApiChannel: true,
    member: "chat",
    handle: async ({ request, response, context, params, who }) => {
      const agent = context.agent(params.id);
      const { thread } = await body(request, z.object({ thread: z.string().min(1) }));
      const runId = stopReply(current(chatThread(agent.id, thread, who)));
      json(response, { stopped: Boolean(runId), ...(runId && { runId }) });
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/threads/:thread/rename",
    does: "Give a conversation started over the API a name, by the thread it was started with. An empty one goes back to the name it was given when it started.",
    takes: '{"label": "..."}',
    token: true,
    needsApiChannel: true,
    handle: async ({ request, response, context, params }) => {
      const agent = context.agent(params.id);
      // Where the chat route keeps a token's thread, so a token names only a
      // conversation started over the API, never one from the page or a channel.
      const thread = `${agent.id}/api-${decodeURIComponent(params.thread)}`;
      const { label: named } = await body(request, z.object({ label: z.string().trim().max(200) }));
      label(thread, named);
      json(response, { thread, label: named || null });
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/model",
    does: "Pick a model on the fly: for one job, or one chat. An empty model takes the pick back.",
    takes: '{"scope": "job:<id>" | "chat:<thread>", "model": "..." or ""}',
    handle: async ({ request, response, context, params }) => {
      const agent = context.agent(params.id);
      const { scope, model } = await body(
        request,
        z.object({ scope: z.string().regex(/^(job:.+|chat:.+)$/, "job:<id> or chat:<thread>"), model: z.string().trim() }),
      );
      if (scope.startsWith("job:") && !agent.jobs.some((one) => one.id === scope.slice(4))) {
        throw new BadRequest(`${agent.id} has no job called ${scope.slice(4)}.`);
      }
      if (model && !models(agent).some((one) => one.model === model)) {
        throw new BadRequest(`${model} is not on offer here. GET /api/models lists what is.`);
      }
      choose(agent.id, scope as Scope, model);
      json(response, summary(agent));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/job/:job",
    does: "Run one of that agent's jobs now, rather than waiting for its cron line. Takes what that job's input shape says.",
    takes: 'whatever the job declares, as JSON or as a query string: {"text": "..."}',
    token: true,
    needsApiChannel: true,
    member: "run",
    handle: async ({ request, response, context, params, url }) => {
      const agent = context.agent(params.id);
      const job = agent.jobs.find((one: Job) => one.id === params.job);
      if (!job) throw new NotFound(`${agent.id} has no job called ${JSON.stringify(params.job)}.`);
      // Started by a message on its channel only: here the sender would be whoever called.
      if (job.channels) throw new BadRequest(`${job.id} answers ${agent.id}'s ${job.channels.join(" and ")} channel, and only a message there starts it.`);

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
        checkArgs(job, sent);
      } catch (error) {
        return json(response, { error: (error as Error).message }, 400);
      }

      void context.clock.fire(agent, job, sent, channelOf(request));
      json(response, { started: `${agent.id}/${job.id}`, log: `/api/agents/${agent.id}/log` });
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/trial/:job",
    does: "Run one of that agent's jobs as a trial, as its files are now, and answer when it ends: it reads for real, and every message and email it would have sent is held back and listed instead. A question for a person ends it.",
    takes: 'whatever the job declares, as JSON or as a query string: {"text": "..."}',
    handle: async ({ request, response, context, params, url }) => {
      const agent = context.agent(params.id);
      const sent = {
        ...Object.fromEntries(url.searchParams),
        ...(await body(request, z.record(z.string(), z.unknown()))),
      };
      try {
        json(response, await tryJob(agent, params.job, { input: sent, source: channelOf(request), through: context.clock }));
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
    },
  },

  // Writing, and the tokens themselves. The account and nothing else.
  {
    method: "POST",
    path: "/api/agents/:id/file",
    does: "Write a file in that agent's folder back. Markdown only: code is edited where the type checker runs.",
    takes: '{"path": "skills/x.md", "content": "..."}',
    handle: async ({ request, response, context, params }) => {
      context.agent(params.id);
      const { path, content } = await body(request, z.object({ path: z.string(), content: z.string() }));
      if (!editable(path)) {
        return json(response, { error: `${path} is not markdown, so it cannot be written from here.` }, 400);
      }
      json(response, await save(params.id, path, content));
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/archive",
    does: "Archive a run, or bring it back. It is kept whole either way: the log leaves an archived run out.",
    takes: '{"archived": true}',
    handle: async ({ request, response, params }) => {
      const { archived } = await body(request, z.object({ archived: z.boolean() }));
      const at = archived ? new Date().toISOString() : null;
      if (db.prepare("update runs set archived = ? where id = ?").run(at, params.id).changes === 0) throw new NotFound("No run with that id.");
      json(response, { id: params.id, archived: at });
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/answer",
    does: "Answer a job that stopped to ask something, from here rather than on the channel it asked on.",
    takes: '{"text": "..."}',
    handle: async ({ request, response, context, params }) => {
      const { text } = await body(request, z.object({ text: z.string().trim().min(1) }));
      json(response, await answer(params.id, text, context.agents()));
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/carry-on",
    does: "Pick up a job's prompt that the service stopped in the middle of, or that ran out of steps, in the same run, from where it stopped. One that ran out of steps is given as many again.",
    handle: ({ response, context, params }) => {
      let run;
      try {
        run = stopped(params.id);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      const agent = context.agent(run.agent);
      const job = agent.jobs.find((one: Job) => one.id === run.job);
      if (!job || job.run) throw new BadRequest(`${agent.id} no longer has a prompt job called ${run.job}, so there is nothing to carry on with.`);
      if (context.clock.running().includes(`${agent.id}/${job.id}`)) {
        throw new BadRequest(`${agent.id}/${job.id} is running now. Carry this one on once it has finished.`);
      }
      void context.clock.carryOn(agent, job, params.id);
      json(response, { carrying: params.id, log: `/api/runs/${params.id}` });
    },
  },
  {
    method: "POST",
    path: "/api/threads/:thread/rename",
    does: "Give a conversation a name. An empty one goes back to the name it was given when it started.",
    takes: '{"label": "..."}',
    member: "filtered",
    handle: async ({ request, response, params, who }) => {
      const thread = threadFor(who, decodeURIComponent(params.thread));
      if (!may(who, thread.split("/")[0], "chat")) throw new NotFound("No such conversation.");
      const { label: named } = await body(request, z.object({ label: z.string().trim().max(200) }));
      label(thread, named);
      json(response, { thread, label: named || null });
    },
  },
  {
    method: "POST",
    path: "/api/threads/:thread/archive",
    does: "Archive a conversation, or bring it back. It is kept, and the agent still remembers it.",
    takes: '{"archived": true}',
    member: "filtered",
    handle: async ({ request, response, params, who }) => {
      const thread = threadFor(who, decodeURIComponent(params.thread));
      if (!may(who, thread.split("/")[0], "chat")) throw new NotFound("No such conversation.");
      const { archived } = await body(request, z.object({ archived: z.boolean() }));
      const at = archived ? new Date().toISOString() : null;
      db.prepare("insert into threads (thread, archived) values (?, ?) on conflict (thread) do update set archived = excluded.archived").run(thread, at);
      json(response, { thread, archived: at });
    },
  },
  {
    method: "POST",
    path: "/api/threads/:thread/forget",
    does: "Forget one conversation.",
    member: "filtered",
    handle: ({ response, params, who }) => {
      const thread = threadFor(who, decodeURIComponent(params.thread));
      if (!may(who, thread.split("/")[0], "chat")) throw new NotFound("No such conversation.");
      forget(thread);
      json(response, { forgotten: thread });
    },
  },
  {
    method: "GET",
    path: "/api/keys",
    does: "The names .env sets, and whether chloe.config.ts hands each over. Never a value.",
    handle: async ({ response }) => json(response, await keysUsed()),
  },
  {
    method: "POST",
    path: "/api/keys",
    does: "Write NAME=value lines into .env, each replacing the line that name had. Only CHLOE_ names, one line each, except one name given JSON, which goes in on one line. The settings are read again at once.",
    takes: '{"lines": "CHLOE_CONNECTIONS_BRAVE_API_KEY=..."}',
    handle: async ({ request, response }) => {
      const { lines } = await body(request, z.object({ lines: z.string() }));
      // A client file pasted whole is JSON over many lines, and goes in as one.
      const whole = /^\s*(CHLOE_[A-Z0-9_]+)=(\{[\s\S]*\})\s*$/.exec(lines);
      const flat = whole && (() => { try { return JSON.stringify(JSON.parse(whole[2])); } catch { return undefined; } })();
      const given = whole && flat ? { [whole[1]]: flat } : readEnvFile(lines);
      if (!Object.keys(given).length) throw new BadRequest("No NAME=value line in that.");
      try {
        writeEnv(given);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      json(response, await keysUsed());
    },
  },
  {
    method: "POST",
    path: "/api/keys/:name/remove",
    does: "Take that name's line out of .env.",
    handle: async ({ response, params }) => {
      try {
        writeEnv({ [params.name]: null });
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      json(response, await keysUsed());
    },
  },
  {
    method: "GET",
    path: "/api/config/settings",
    does: "Each setting the Configuration page changes: its value (never a secret's), whether it is set, and whether the file says it plainly, from .env, or as code.",
    handle: async ({ response }) => json(response, await configFields()),
  },
  {
    method: "GET",
    path: "/api/config/sections",
    does: "Each plugin's section of the Configuration page, the services mail can be sent with, and the ways to reach a model, in their default order.",
    handle: ({ response }) =>
      json(response, {
        sections: PLUGINS.flatMap((one) => (one.configuration ? [{ id: one.name, ...one.configuration }] : [])),
        emailProviders: Object.entries(providers()).map(([name, one]) => [name, one.label ?? name]),
        routes: ROUTES,
      }),
  },
  {
    method: "POST",
    path: "/api/config/settings",
    does: "Change settings in chloe.config.ts in one save, a secret into .env and named in the config. null puts the default back. Refused where the file says it as code.",
    takes: '{"changes": [{"path": "connections.google.account", "value": "you@gmail.com"}]}',
    handle: async ({ request, response }) => {
      const { changes } = await body(request, z.object({ changes: z.array(z.object({ path: z.string(), value: z.unknown() })).min(1) }));
      try {
        await changeSettings(changes.map((one) => ({ path: one.path, value: one.value ?? null })));
      } catch (error) {
        if (error instanceof NotFound) throw error;
        throw new BadRequest(error instanceof InCode ? `${error.message}` : (error as Error).message);
      }
      json(response, await configFields());
    },
  },
  {
    method: "GET",
    path: "/api/config",
    does: "The text of chloe.config.ts.",
    handle: async ({ response }) => json(response, { text: await configText() }),
  },
  {
    method: "POST",
    path: "/api/config",
    does: "Write chloe.config.ts. Loaded and type checked first, as the next reload would, and put back with the reason when it fails.",
    takes: '{"text": "the whole file"}',
    handle: async ({ request, response }) => {
      const { text } = await body(request, z.object({ text: z.string().min(1) }));
      try {
        await saveConfig(text);
      } catch (error) {
        if (error instanceof NotFound) throw error;
        throw new BadRequest((error as Error).message);
      }
      json(response, { ok: true });
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
    does: "Make a token. The only time the secret exists in one piece is in this reply. With an agent, it reaches that agent and nothing else.",
    takes: '{"name": "what it is for", "agent": "optional, the one agent it reaches"}',
    handle: async ({ request, response, context }) => {
      const { name, agent } = await body(request, z.object({ name: z.string().trim().min(1), agent: z.string().optional() }));
      if (agent) context.agent(agent);
      const { secret, token } = makeToken(name, agent || undefined);
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
    path: "/api/agents/:id/memory",
    does: "That agent's memory as a tree. Empty when it has never written anything. Recorded like a read.",
    member: "memory",
    handle: async ({ request, response, context, params }) =>
      json(response, await memoryTree(context.agent(params.id), from(request))),
  },
  {
    method: "GET",
    path: "/api/agents/:id/memory/file",
    does: "One file as text, for editing. Takes ?path=. Written to the audit log before it is sent.",
    member: "memory",
    handle: async ({ request, response, context, params, url }) => {
      const path = url.searchParams.get("path");
      if (!path) return json(response, { error: "No path." }, 400);
      const found = await memoryOpen(context.agent(params.id), path, from(request));
      if (!found) throw new NotFound(`Nothing at ${path}.`);
      json(response, found);
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/memory/file",
    does: "Write a file back. A commit too, when the memory is a repo and the agent says to commit.",
    takes: '{"path": "01_projects/x.html", "content": "..."}',
    handle: async ({ request, response, context, params }) => {
      const { path, content } = await body(request, z.object({ path: z.string(), content: z.string() }));
      json(response, await memorySave(context.agent(params.id), path, content, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/memory/rename",
    does: "Move a file or a folder inside that memory.",
    takes: '{"from": "a.html", "to": "b/a.html"}',
    handle: async ({ request, response, context, params }) => {
      const moved = await body(request, z.object({ from: z.string().min(1), to: z.string().min(1) }));
      json(response, await memoryRename(context.agent(params.id), moved.from, moved.to, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/memory/delete",
    does: "Delete a file or a folder. In a repo, git still has it.",
    takes: '{"path": "a.html"}',
    handle: async ({ request, response, context, params }) => {
      const { path } = await body(request, z.object({ path: z.string().min(1) }));
      json(response, await memoryDelete(context.agent(params.id), path, from(request)));
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/memory/pass",
    does: "A pass to show that memory's files in a frame, for ten minutes. See pass.ts.",
    member: "memory",
    handle: ({ request, response, context, params }) => {
      // An agent that runs elsewhere has its frame served from here too, so the pass is this copy's.
      const pass = makePass(elsewhere(params.id)?.agent ?? context.agent(params.id).id, from(request));
      json(response, { pass, at: `/memory/${encodeURIComponent(pass)}` });
    },
  },
  {
    method: "GET",
    path: "/api/agents/:id/memory/log",
    does: "That agent's audit log: every file read, served, written, moved or deleted, when, and from where.",
    handle: async ({ response, context, params, url }) =>
      json(
        response,
        await memoryLog(context.agent(params.id), Math.min(Number(url.searchParams.get("limit") ?? 200), 1000)),
      ),
  },
  {
    method: "GET",
    path: "/api/agents/:id/memory/git",
    does: "Source control for that memory, when it is a repo: what changed, the branch, and the recent history.",
    handle: async ({ response, context, params }) => json(response, await memoryGit(context.agent(params.id))),
  },
  {
    method: "POST",
    path: "/api/agents/:id/memory/git/commit",
    does: "Commit everything that changed in that memory.",
    takes: '{"message": "..."}',
    handle: async ({ request, response, context, params }) => {
      const { message } = await body(request, z.object({ message: z.string() }));
      json(response, await memoryCommit(context.agent(params.id), message, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/memory/git/push",
    does: "Push that memory's commits. Says where they went, because this is what sends them off the box.",
    handle: async ({ request, response, context, params }) =>
      json(response, await memoryPush(context.agent(params.id), from(request))),
  },
  {
    method: "POST",
    path: "/api/agents/:id/memory/git/pull",
    does: "Pull, fast-forward only.",
    handle: async ({ request, response, context, params }) =>
      json(response, await memoryPull(context.agent(params.id), from(request))),
  },

  // What an agent changed: the commits in its memory and in its own folder.
  // A memory's are recorded like any read of it, so none of these takes a token.
  {
    method: "GET",
    path: "/api/agents/:id/changes",
    does: "Commits to that agent's memory and own folder, newest first, the ones it made since somebody last looked marked new. Takes ?in=memory|folder, ?path= for one file's history, and ?limit=, at most 200.",
    handle: async ({ request, response, context, params, url }) =>
      json(
        response,
        await agentChanges(
          context.agent(params.id),
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
    path: "/api/agents/:id/changes/:change",
    does: "One commit and its diff, cut to that agent's part of the repository. Takes ?in=memory|folder.",
    handle: async ({ request, response, context, params, url }) => {
      const place = placeOf(url.searchParams.get("in"));
      if (!place) return json(response, { error: "Say which: ?in=memory or ?in=folder." }, 400);
      json(response, await agentChange(context.agent(params.id), place, params.change, from(request)));
    },
  },
  {
    method: "POST",
    path: "/api/agents/:id/changes/seen",
    does: "Everything that agent has changed up to now has been looked at.",
    handle: ({ response, context, params }) => json(response, agentSeen(context.agent(params.id))),
  },
  {
    method: "POST",
    path: "/api/agents/:id/changes/:change/undo",
    does: "Put every file one commit changed back how it was, and commit that. Refused when a file has changed since.",
    takes: '{"in": "memory"}',
    handle: async ({ request, response, context, params }) => {
      const { in: place } = await body(request, z.object({ in: z.enum(["memory", "folder"]) }));
      json(response, await agentUndo(context.agent(params.id), place, params.change, from(request)));
    },
  },
];

/** Signing in with a password or a link: `signing` hands back the session, or throws why not. */
function wayIn({ request, response }: At, signing: () => string, owner = true): void {
  try {
    // The same value twice: the cookie for a browser, and the body for
    // anything that is not one.
    const token = signing();
    // A new address is mailed for the owner's account. Somebody invited
    // signing in is not the account being used from somewhere new.
    if (owner) signedInFrom(from(request));
    response.setHeader("set-cookie", setCookie(token, overHttps(request)));
    json(response, { ok: true, token });
  } catch (error) {
    json(response, { error: (error as Error).message }, 401);
  }
}

/** Every route: the ones above, then each plugin's. */
function allRoutes(): Route[] {
  return [...routes, ...PLUGINS.flatMap((one) => one.routes ?? [])];
}

/** Every route as GET /api lists it: what it does, and who may call it. */
export function routeList() {
  return allRoutes().map((one) => ({
    method: one.method,
    path: one.path,
    does: one.does,
    takes: one.takes,
    who: one.open ? "anybody" : one.token ? "account or token" : "account",
    member: one.member,
    needsApiChannel: one.needsApiChannel || undefined,
  }));
}

/** The route whose path matches, with whatever its `:parts` caught. */
function match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  const parts = path.split("/").filter(Boolean);
  for (const route of allRoutes()) {
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

/** When this copy was last asked anything over its port, for `serve.stopAfter`. */
let lastAsked = Date.now();

/** How long it has been since anything was asked over the port, in milliseconds. */
export function quietFor(): number {
  return Date.now() - lastAsked;
}

export function serve(options: {
  host: string;
  port: number;
  agents: () => Map<string, Agent>;
  clock: Clock;
  /** What the running channels answer, asked again on every request because a channel can start or stop. */
  channels: () => ChannelRoute[];
  /** The port already held by `claimPort`, which the server takes over in place of opening its own. */
  heldPort?: PortHolder;
  /** Serve the page over HTTPS with this, to every address, as `npx chloe --remote` does. Needs `heldPort`. */
  certificate?: Certificate;
}): PortHolder {
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

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    lastAsked = Date.now();
    let url: URL;
    let path: string;
    try {
      // Parsed inside the try on purpose: a path or Host the parser cannot
      // read throws here, and that must be a 400 and never a dead process.
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      path = url.pathname.replace(/\/+$/, "") || "/";
    } catch {
      return void json(response, { error: "That address cannot be read." }, 400);
    }
    try {
      const channel = options.channels().find((one) => one.path === path && (one.methods ?? ["POST"]).includes(request.method as "GET" | "POST"));
      if (channel) return await channel.handle(request, response);
      if (path === "/api" || path.startsWith("/api/")) return await api(request, response, path, url, context);
      if (path.startsWith("/memory/") && request.method === "GET") return await framed(request, response, url, context);
      await servePage(response, path);
    } catch (error) {
      if (error instanceof NotFound) return json(response, { error: error.message }, 404);
      if (error instanceof BadRequest) return json(response, { error: error.message }, 400);
      if (error instanceof Refused) return json(response, { error: error.message }, error.status);
      console.error(`${request.method} ${path}:`, error);
      json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };

  if (options.certificate && options.heldPort) return bothWays(options.heldPort, handle, options.certificate);
  const server = createServer(handle);
  // The port this copy opened first thing, now handed to the server, so it is
  // never free in between for a second copy to take.
  if (options.heldPort) server.listen(options.heldPort);
  else server.listen(options.port, options.host);
  return server;
}

/**
 * One port answering two ways, told apart by the first byte a caller sends.
 * HTTPS goes to the page from anywhere. Plain HTTP is answered only from this
 * machine, which is what `npx chloe agent` and `npx chloe link` call, and from
 * anywhere else is sent on to the same address over HTTPS.
 */
function bothWays(port: PortHolder, handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>, certificate: Certificate): PortHolder {
  const secure = createSecureServer({ key: certificate.key, cert: certificate.cert }, handle);
  const plain = createServer(handle);
  const elsewhere = createServer((request, response) => {
    response.writeHead(301, { location: `https://${request.headers.host ?? "localhost"}${request.url ?? "/"}` }).end();
  });
  port.on("connection", (socket: Socket) => {
    const gone = () => socket.destroy();
    socket.on("error", gone);
    socket.once("readable", () => {
      const first = socket.read(1) as Buffer | null;
      if (!first) return gone();
      socket.unshift(first);
      socket.off("error", gone);
      const loopback = /^(127\.|::1$|::ffff:127\.)/.test(socket.remoteAddress ?? "");
      (first[0] === 0x16 ? secure : loopback ? plain : elsewhere).emit("connection", socket);
    });
  });
  return port;
}

/**
 * Holds the port before anything else starts, so a second copy started by
 * mistake stops here: before it closes the runs it would take for cut off by
 * a crash, and before its clock and channels run beside the first copy's.
 * Hand what it returns to `serve` as `heldPort`.
 */
export function claimPort(host: string, port: number): Promise<PortHolder> {
  return new Promise((done, fail) => {
    const holder = createPortHolder();
    holder.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return fail(error);
      fail(new Error(`Port ${port} on ${host} is taken, most likely by chloe already running. This copy stops here and touches nothing. To run a second one, give it another serve.port.`));
    });
    holder.listen(port, host, () => done(holder));
  });
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
  const whose = checkPass(pass, from(request));
  const refuse = (status: number, text: string): void =>
    void response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
  if (!whose) return refuse(403, "This pass has run out. Open the file again.");
  const agent = context.agents().get(whose);
  const there = agent ? undefined : elsewhere(whose);
  if (!agent && !there) return refuse(404, "Not here.");

  const path = rest.map(decodeURIComponent).join("/");
  const found = agent
    ? await memoryRaw(agent, path, from(request), `/memory/${raw}`)
    : await framedElsewhere(there!, path, request, `/memory/${raw}`);
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
  if (request.method === "OPTIONS") return preflight(request, response, path, context);

  // An agent that runs in another copy of chloe: that copy answers, for the owner only.
  const there = await whereElse(path, url);
  if (there) {
    const who = caller(request);
    if (!who) return json(response, { error: "Sign in first." }, 401);
    if (who.kind !== "account") {
      return json(response, { error: `${there.agent} runs in another copy of chloe, and only its owner reaches it from here.` }, 403);
    }
    return passOn(request, response, there, `${path}${url.search}`);
  }

  const found = match(request.method ?? "GET", path);
  if (!found) throw new NotFound(`No route for ${request.method} ${path}. GET /api lists them.`);
  const { route, params } = found;

  // A page on another site: only one the route names, and the browser is told so.
  const origin = request.headers.origin;
  if (route.origins && origin) {
    if (!route.origins({ params, context }).includes(origin)) return json(response, { error: "A page on this site may not call this." }, 403);
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }

  const who = caller(request);
  if (!route.open) {
    if (!who) return json(response, { error: "Sign in first." }, 401);
    if (who.kind === "token" && !route.token) {
      return json(response, { error: "A token cannot do that. That one is the account's." }, 403);
    }
    if (who.kind === "token" && who.token.agent && params.id !== who.token.agent) {
      return json(response, { error: `This token is for ${who.token.agent}, and reaches nothing else.` }, 403);
    }
    if (who.kind === "token" && route.needsApiChannel && !onTheApi(context.agent(params.id))) {
      return json(
        response,
        { error: `${params.id} has no api channel, so a token cannot reach it. Bind one to open it.` },
        403,
      );
    }
    if (who.kind === "member") {
      const refused = refusedMember(route, params, who.given);
      if (refused) return json(response, { error: refused }, 403);
    }
  }

  await route.handle({ request, response, url, params, context, who });
}

/**
 * A browser asking, before it calls a route from a page on another site,
 * whether it may: yes for a site the route names, and a bare 403 otherwise.
 */
function preflight(request: IncomingMessage, response: ServerResponse, path: string, context: Context): void {
  const found = (["GET", "POST"] as const).map((method) => match(method, path)).find((one) => one?.route.origins);
  const origin = request.headers.origin;
  if (!found || !origin || !found.route.origins!({ params: found.params, context }).includes(origin)) {
    return void response.writeHead(403, { vary: "origin" }).end();
  }
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST",
    "access-control-allow-headers": ["content-type", ...(found.route.headers ?? [])].join(", "),
    "access-control-max-age": "600",
    vary: "origin",
  });
  response.end();
}

export function json(response: ServerResponse, value: unknown, status = 200): void {
  const text = JSON.stringify(value, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(text);
}

/**
 * A request's JSON, in the shape the route says it takes, or a 400 saying
 * what did not fit. Capped by bytes, so a bad caller cannot fill memory, and
 * decoded once at the end: decoding chunk by chunk turns a character that
 * straddles two chunks into two replacement marks.
 */
export async function body<Shape extends z.ZodType>(request: IncomingMessage, shape: Shape, most = 1_000_000): Promise<z.infer<Shape>> {
  const text = await new Promise<string>((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > most) {
        fail(new BadRequest("Body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
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
