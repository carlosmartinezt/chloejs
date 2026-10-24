// The machine: the proxy that is the shell's only way out, and the checks the
// shell ability makes as an agent loads. The tool itself runs commands through
// sudo as another user, so it is exercised by hand in a machine built from the
// machine/ folder (docs/machines.md), not here.
import { createServer, request } from "node:http";
import { connect, createServer as listenTCP } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { about, is } from "#chloe/ops/check";
import { gatewayUrl } from "#chloe/ops/test/shared";

// Hold the machine's settings over what the suite already holds, passing the
// rest through unchanged: holdSettings replaces, so leaving the rest out would
// put every test after this back on this project's own model routes.
const { holdSettings, settings } = await import("#chloe/core/settings");
const holdMachine = (machine: { own: boolean; user: string; workspace: string; hosts: string[] }) =>
  holdSettings({
    model: { key: settings.model.key, preferredRoute: settings.model.preferredRoute, gatewayUrl, program: settings.model.program },
    email: settings.email,
    owner: settings.owner,
    machine,
  });
const workspace = mkdtempSync(`${tmpdir()}/chloe-workspace-`);
holdMachine({ own: true, user: "shell", workspace, hosts: ["127.0.0.1", "*.localtest"] });

{
  about("the shell ability's checks as an agent loads");

  const { machine } = await import("./plugin.ts");
  const shell = machine.abilities!.find((one) => one.name === "shell")!;
  const home = { id: "test", folder: tmpdir(), memory: { folder: `${tmpdir()}/memory-of-test` } };
  is("a machine of its own with a workspace loads the ability", (() => {
    shell.check!(home, {}, "test");
    return true;
  })(), true);

  holdMachine({ own: false, user: "shell", workspace: "/nowhere", hosts: ["127.0.0.1"] });
  const off = (() => {
    try {
      shell.check!(home, {}, "test");
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  is("a chloe not in a machine of its own refuses it", off.startsWith("test has abilities.shell on, but this chloe is not in a machine of its own"), true);

  holdMachine({ own: true, user: "shell", workspace: "/nowhere", hosts: ["127.0.0.1"] });
  const missing = (() => {
    try {
      shell.check!(home, {}, "test");
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  is("and so does a machine whose workspace folder is not there", missing.startsWith("test has abilities.shell on, and no workspace folder at /nowhere"), true);

  holdMachine({ own: true, user: "shell", workspace, hosts: ["127.0.0.1", "*.localtest"] });
}

{
  about("the proxy the shell reaches the internet through");

  const { allowed, machineProxy } = await import("./proxy.ts");
  const port = await machineProxy();
  is("it listens on loopback", port > 0, true);
  is("an allowed host is allowed", allowed("127.0.0.1"), true);
  is("a host that is not is not", allowed("example.com"), false);
  is("a wildcard covers the bare host and everything under it", [allowed("localtest"), allowed("two.raw.localtest")], [true, true]);
  is("but not a host the wildcard does not name", allowed("notlocaltest"), false);

  // A plain TCP server whose every connection opens with a banner, and a plain
  // http one, to see that the proxy carries both.
  const tcpPort = await new Promise<number>((start) => {
    const server = listenTCP((socket) => socket.write("over the tunnel\n"));
    server.listen(0, "127.0.0.1", () => start((server.address() as { port: number }).port));
  });
  const httpPort = await new Promise<number>((start) => {
    const server = createServer((one, answer) => answer.end("over plain http"));
    server.listen(0, "127.0.0.1", () => start((server.address() as { port: number }).port));
  });

  const through = await new Promise<string>((done) => {
    const client = connect(port, "127.0.0.1", () => client.end(`CONNECT 127.0.0.1:${tcpPort} HTTP/1.1\r\n\r\n`));
    let said = "";
    client.on("data", (part) => {
      said += part.toString();
      if (said.includes("over the tunnel")) done(said.split("\r\n")[0]);
    });
    client.on("error", () => done(`error: ${said}`));
  });
  is("a tunnel to an allowed host is opened and carries bytes", through, "HTTP/1.1 200 Connection established");

  const refused = await new Promise<string>((done) => {
    const client = connect(port, "127.0.0.1", () => client.end("CONNECT example.com:443 HTTP/1.1\r\n\r\n"));
    let said = "";
    client.on("data", (part) => {
      said += part.toString();
      if (said.includes("(machine.hosts)")) done(said.split("\r\n")[0]);
    });
    client.on("error", () => done(`error: ${said}`));
  });
  is("a tunnel to a host that is not allowed is refused, saying why", refused, "HTTP/1.1 403 Forbidden");

  const plain = await new Promise<string>((done) => {
    const one = request(
      { host: "127.0.0.1", port, path: `http://127.0.0.1:${httpPort}/file`, method: "GET" },
      (from) => {
        let said = "";
        from.on("data", (part) => (said += part.toString()));
        from.on("end", () => done(`${from.statusCode} ${said}`));
      },
    );
    one.on("error", () => done("error"));
    one.end();
  });
  is("a plain http request to an allowed host is carried", plain, "200 over plain http");

  const refusedPlain = await new Promise<string>((done) => {
    const one = request(
      { host: "127.0.0.1", port, path: "http://example.com/file", method: "GET" },
      (from) => {
        let said = "";
        from.on("data", (part) => (said += part.toString()));
        from.on("end", () => done(`${from.statusCode} ${said}`));
      },
    );
    one.on("error", () => done("error"));
    one.end();
  });
  is("and one to any other host is refused", refusedPlain.startsWith("403 example.com is not on this machine's list of hosts"), true);
}

{
  about("the folder a shell command runs in");

  const { shellRun } = await import("./tools.ts");
  const run = shellRun().execute as (input: { command: string; folder?: string }, options: unknown) => Promise<unknown>;
  const refused = await run({ command: "ls", folder: "../data" }, {}).then(() => "ran", (error: Error) => error.message);
  is("a folder that escapes the workspace is refused before anything runs", refused, 'folder is a name inside the workspace, like "saveyourchess", not "../data".');
  const absolute = await run({ command: "ls", folder: "/etc" }, {}).then(() => "ran", (error: Error) => error.message);
  is("and so is an absolute path", absolute, 'folder is a name inside the workspace, like "saveyourchess", not "/etc".');
}
