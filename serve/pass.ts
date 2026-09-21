// A pass to read one agent's memory, carried in the address rather than in a
// cookie, for the frame a memory file is shown in.
//
// Why not the cookie. A memory file is somebody's own HTML, and every one of
// them runs its own script. So it is served sandboxed (see memory.ts), which
// gives the document an origin of its own that is nobody's: its scripts run,
// but they cannot reach the page around them or call the API as the person
// signed in. That is the whole point. It also means the browser will not send
// the session cookie for the stylesheet and the script the file links, because
// that origin is not this site. So those need another way to show they may be
// served, and a pass in the path is it: the file's own relative and
// root-relative links resolve under the pass and carry it with them.
//
// What a pass can do is exactly what a frame needs and nothing else: read files
// in one agent's memory, for ten minutes. It cannot write, cannot reach another
// agent's memory, cannot make a token or talk to an agent. A script in a note
// can read the pass from its own address, which is fine: it is already running
// inside that agent's memory, and connect-src 'none' stops it sending the pass
// anywhere.
import { seal, unseal } from "./login.ts";

/** Long enough to load a frame and everything it links, short enough to be worthless later. */
const LASTS = 10 * 60;

const PURPOSE = "memory-pass";

interface Payload {
  /** Whose memory. */
  a: string;
  /** Until when, in seconds since the epoch. */
  u: number;
}

/** A pass to read that agent's memory. */
export function makePass(agent: string): string {
  return seal(PURPOSE, { a: agent, u: Math.floor(Date.now() / 1000) + LASTS } satisfies Payload);
}

/** Which agent's memory this pass reads, or null when it is not a live pass. */
export function checkPass(value: string): string | null {
  const payload = unseal<Payload>(PURPOSE, value);
  if (!payload || typeof payload.a !== "string" || typeof payload.u !== "number") return null;
  if (payload.u <= Math.floor(Date.now() / 1000)) return null;
  return payload.a;
}
