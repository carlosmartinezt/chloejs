// A connection to a service's MCP server: the list of tools the service
// publishes for models, reached over HTTP. An agent lists one in its
// `connections`, and gets that service's tools without anybody writing them:
//
//   connections: [mcpConnection({ name: "github", url: "https://api.githubcopilot.com/mcp/",
//     token: process.env.GITHUB_TOKEN, tools: ["list_issues", "get_issue"] })]
//
// Each tool is named like chloe's own, the connection's name then the tool's in
// one word: github's `list_issues` is `githubListIssues`. The list is asked for
// as the agent loads, and a server that does not answer leaves the agent
// loading without those tools, with the reason on the setup page.
//
// A connection reaches whatever its key reaches, so it is for services where
// that is what the agent should have. Narrow it with `tools`. Mail and notes
// are tools of chloe's own instead, bound to what one agent may see.
import { createMCPClient } from "@ai-sdk/mcp";
import { jsonSchema, tool } from "ai";

import type { Connection } from "#chloe/connections/connection";
import type { Tools } from "#chloe/model/tool";

/** What `mcpConnection` is given: which server, its key, and which of its tools. */
export interface McpOptions {
  /** What it is called, and the first word of every tool it brings: `github`. */
  name: string;
  /** The server's address, which the service's docs give. Streamable HTTP. */
  url: string;
  /**
   * The key, sent as `Authorization: Bearer`. Either the key, handed over as
   * `process.env.SOME_NAME`, or a function that fetches one when it is needed,
   * for a key kept somewhere that hands out short-lived ones.
   */
  token?: string | (() => string | undefined | Promise<string | undefined>);
  /** Other headers the server wants, for a service that does not take a bearer key. */
  headers?: Record<string, string>;
  /** Only these of the server's tools, by the server's own names. Unsaid is all of them. */
  tools?: string[];
  /** What it is for, in one line, for the setup page. */
  does?: string;
}

/** A service's MCP server: a connection that also hands the loader its tools. */
export interface McpConnection extends Connection {
  tools(): Promise<Tools>;
}

/** How long a server has to answer as the agent loads, or a call. */
const WAIT = 15_000;

/** `list_issues` as `ListIssues`, so `github` and it make `githubListIssues`. */
export function toolName(connection: string, name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return connection + words.map((one) => one[0].toUpperCase() + one.slice(1)).join("");
}

/** The text of what a tool handed back, its parts one after another. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : JSON.stringify(part)))
    .join("\n");
}

/** One MCP server, for an agent's `connections`. Nothing is asked of it until the agent loads. */
export function mcpConnection(options: McpOptions): McpConnection {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(options.name)) {
    throw new Error(`mcpConnection: name is one word starting with a small letter, like "github", not ${JSON.stringify(options.name)}.`);
  }
  const headers = async (): Promise<Record<string, string>> => {
    const key = typeof options.token === "function" ? await options.token() : options.token;
    return { ...options.headers, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  };
  const open = async () =>
    await createMCPClient({
      transport: { type: "http", url: options.url, headers: await headers() },
      clientName: "chloe",
      initializationOptions: { timeout: WAIT },
    });

  const connection: McpConnection = {
    name: options.name,
    does: options.does ?? `The tools ${new URL(options.url).hostname} publishes for models.`,
    settings: [],
    async missing() {
      if (options.token !== undefined && !(typeof options.token === "function" ? await options.token() : options.token)) {
        return [`${options.name} has no key: the token it was handed is empty`];
      }
      try {
        const client = await open();
        await client.close();
        return [];
      } catch (error) {
        return [`${options.url} did not answer: ${(error as Error).message}`];
      }
    },
    async tools() {
      const client = await open();
      let listed;
      try {
        listed = await client.listTools({ options: { timeout: WAIT } });
      } finally {
        await client.close();
      }
      const wanted = options.tools && new Set(options.tools);
      const out: Tools = {};
      for (const one of listed.tools) {
        if (wanted && !wanted.has(one.name)) continue;
        // A client per call: a server restarted between two calls is then
        // nothing anybody has to notice.
        const made = tool({
          description: one.description ?? one.title ?? one.name,
          inputSchema: jsonSchema(one.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (input) => {
            const client = await open();
            try {
              const result = await client.callTool({
                name: one.name,
                arguments: input as Record<string, unknown>,
                options: { timeout: WAIT * 4 },
              });
              const text = textOf(result.content);
              if (result.isError) throw new Error(text || `${one.name} failed`);
              return text;
            } finally {
              await client.close();
            }
          },
        });
        out[toolName(options.name, one.name)] = Object.assign(made, { needs: connection });
      }
      return out;
    },
  };
  return connection;
}
