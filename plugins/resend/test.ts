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

{
  about("mailing a person a password link through Resend");
  const { resend } = await import("./plugin.ts");
  const { settings } = await import("#chloe/core/settings");
  const before = { ...settings.connections.resend };
  const provider = settings.email.provider;
  const toPerson = resend.alerts!.toPerson!;
  Object.assign(settings.connections.resend, { api_key: "", email_from: "Chloe <info@example.com>" });
  is("with no key it cannot", toPerson.ready(), false);
  settings.connections.resend.api_key = "re_test";
  settings.email.provider = "resend";
  is("with a key and a From line it can, whether or not alerts are on", [toPerson.ready(), (settings.connections.resend.alerts = false, toPerson.ready())], [true, true]);
  settings.email.provider = "none";
  is("and not when every mail is off", toPerson.ready(), false);
  Object.assign(settings.connections.resend, before);
  settings.email.provider = provider;
}
