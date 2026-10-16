// Resend: what its tool brings with it.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, is } from "#chloe/ops/check";

{
  about("what the Resend tool brings with it");
  const resend = await import("@chloejs/core/tools/resend");
  const { defineAgent } = await import("@chloejs/core");
  const { resolveAgent } = await import("#chloe/load/load");
  const sender = { when: "it reaches nobody", from: "a@b.co", to: ["c@d.co"] };
  const made = await resolveAgent(
    defineAgent({ id: "mail", folder: await mkdtemp(join(tmpdir(), "chloe-mail-")), model: "m", identity: "", purpose: "Hi.", tools: { resendSendEmail: resend.sendEmail(sender) } }),
  );
  is("resendSendEmail has nothing to sign in to", Object.keys(made.tools ?? {}).filter((name) => !made.toolsFrom?.[name]), ["resendSendEmail"]);
}
