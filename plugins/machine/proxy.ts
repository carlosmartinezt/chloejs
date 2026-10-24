// The proxy chloe runs for the machine's shell user, on loopback. It is the
// shell's way to the internet: the hosts in `machine.hosts` and nothing else,
// and it holds no key and adds no credentials, so what the shell runs cannot
// push or upload anywhere the owner did not name.
//
// The machine's image is meant to stop the shell user reaching the internet
// any other way, with firewall rules its entrypoint adds. Where that could not
// be done (a rootless container, today), the entrypoint says so in the
// machine's log, and this proxy is the only way out that well-behaved tools
// take.
import { createServer, request } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

import { settings } from "#chloe/core/settings";

/** The proxy listening, once it has started: a promise of its port. */
let listening: Promise<number> | undefined;

/** Hosts this proxy has refused, so each is logged once. */
const refused = new Set<string>();

/** Whether `host` is one of the hosts in `machine.hosts`, read when asked. */
export function allowed(host: string): boolean {
  return settings.machine.hosts.some((one) => {
    if (!one.startsWith("*.")) return one === host;
    const bare = one.slice(2);
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/** Says one host was refused, in the log, once per host. */
function refuse(host: string): void {
  if (refused.has(host)) return;
  refused.add(host);
  console.log(`machine proxy refused ${host}: it is not in machine.hosts.`);
}

/**
 * The port the proxy listens on, starting the proxy if it has not started. It
 * listens on loopback only; the shell tool points the shell's `http_proxy` at
 * it. Started once per process, and the hosts are read again on each request,
 * so a change to `machine.hosts` holds without a restart.
 */
export function machineProxy(): Promise<number> {
  listening ??= new Promise((start, fail) => {
    // A tunnel has no request to time out, so the request timeout is off: the
    // shell tool's own time limit is what ends a long clone, by closing the
    // command whose tunnel this is.
    const server = createServer((one, answer) => {
      // Plain http, with the whole address as the target.
      if (!one.url?.startsWith("http://")) {
        answer.writeHead(400).end("This proxy carries http and https only.");
        return;
      }
      const at = new URL(one.url);
      if (!allowed(at.hostname)) {
        refuse(at.hostname);
        answer.writeHead(403).end(`${at.hostname} is not on this machine's list of hosts (machine.hosts).`);
        return;
      }
      const headers = { ...one.headers, host: at.host } as Record<string, string | string[]>;
      delete headers["proxy-connection"];
      const out = request(
        { method: one.method, headers, host: at.hostname, port: Number(at.port) || 80, path: `${at.pathname}${at.search}` },
        (from) => {
          answer.writeHead(from.statusCode ?? 502, from.headers);
          from.pipe(answer);
        },
      );
      // Either end going away ends the other, so a closed command cannot leave
      // its request open behind it.
      out.on("error", () => answer.destroy());
      one.on("error", () => out.destroy());
      answer.on("close", () => out.destroy());
      one.pipe(out);
    });
    server.requestTimeout = 0;
    server.on("connect", (one: { url?: string }, socket: Duplex, head: Buffer) => {
      const [host, portText] = (one.url ?? "").split(":");
      if (!allowed(host)) {
        refuse(host);
        socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${host} is not on this machine's list of hosts (machine.hosts).`);
        return;
      }
      const out = connect(Number(portText) || 443, host);
      out.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        out.write(head);
        socket.pipe(out);
        out.pipe(socket);
      });
      // Either end taking the tunnel down takes the other with it.
      socket.on("error", () => out.destroy());
      out.on("error", () => socket.destroy());
      socket.on("close", () => out.destroy());
      out.on("close", () => socket.destroy());
    });
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      start(port);
    });
  });
  return listening;
}
