// The connections an agent can list in its `connections`, to the repo that
// installs chloe. Google and Resend are not here: their tools say they need
// them, so an agent that binds one has the connection with nothing to list.
//
//   import { mcpConnection } from "@chloejs/core/connections";
//   connections: [mcpConnection({ name: "github", url, token: process.env.GITHUB_TOKEN })]
//
// Same rule as `index.ts`: adding a name here is publishing it.

export { mcpConnection, type McpOptions } from "./mcp.ts";
