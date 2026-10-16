// The plugins chloe ships, each a folder beside this file. The runtime reads
// them only through this list, so taking one out is deleting its folder and
// its lines here, in the entrance files that publish its names, and in
// site/plugins.ts when it has a part of the page. What each brings is shown
// in this order: abilities, channels, Configuration's sections.
import { addSettings } from "#chloe/core/settings";
import type { Plugin } from "#chloe/load/plugin";
import { discord } from "./discord/plugin.ts";
import { email } from "./email/plugin.ts";
import { google } from "./google/plugin.ts";
import { memory } from "./memory/plugin.ts";
import { resend } from "./resend/plugin.ts";
import { selfImprovement } from "./self-improvement/plugin.ts";
import { slack } from "./slack/plugin.ts";
import { subscriptions } from "./subscriptions/plugin.ts";
import { telegram } from "./telegram/plugin.ts";
import { web } from "./web/plugin.ts";
import { webChannel } from "./web-channel/plugin.ts";
import { whatsapp } from "./whatsapp/plugin.ts";

export const PLUGINS: Plugin[] = [selfImprovement, memory, web, google, resend, subscriptions, telegram, slack, discord, whatsapp, email, webChannel];

for (const one of PLUGINS) if (one.settings) addSettings(one.settings);

// Exported as well, so the published types load each plugin's file, and what
// it adds to `Abilities` and `Settings` reaches the editor of a project using
// chloe.
export { discord, email, google, memory, resend, selfImprovement, slack, subscriptions, telegram, web, webChannel, whatsapp };
