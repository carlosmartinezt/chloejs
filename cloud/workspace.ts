// Which workspace this runtime is, as the cloud said when it let it in.
//
// Its own file so anything may read it without importing the connection, which
// reaches the one port and would make a circle out of anything that port serves.
// Empty until a cloud has answered, so a reader has to cope with not knowing.

let name = "";

/** Said by `cloud/connect.ts` on each welcome. The name, not the label: an address is built from it. */
export function workspaceIs(said: string): void {
  name = said;
}

/** The workspace this runtime is, or "" when no cloud has said. */
export function workspaceName(): string {
  return name;
}
