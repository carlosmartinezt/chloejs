// Self improvement: an agent changing its own purpose, skills, jobs and code
// when its owner asks, each change a commit a person can undo. Its one tool is
// selfWriteFile; the rest is what the agent is told about changing itself.
import { abilityOn } from "#chloe/load/abilities";
import type { Agent } from "#chloe/load/load";
import type { Plugin, Reply } from "#chloe/load/plugin";
import { dashboardAddress } from "#chloe/core/turn";
import { guides, ownFiles } from "#chloe/services/selfService";
import { whyNot } from "./changeService.ts";
import { selfWriteTools } from "./tools.ts";

declare module "#chloe/load/abilities" {
  interface Abilities {
    /**
     * Adds the tool `selfWriteFile`, which lets the agent change its own files:
     * its purpose, skills and jobs, and its code (`agent.ts`, jobs, tools,
     * services, channels, scripts). On by default, which suits an agent that is
     * still being shaped; switch it off once it does what you want.
     *
     * Each change is saved as a git commit, so you can see it and undo it on
     * the dashboard. A change with code in it is loaded and type checked first,
     * and put back with the reason when that fails. The agent can only use this
     * tool in a reply to a message from its owner. It cannot use it after
     * another tool in the same reply has read something from outside the agent
     * (an email, a web page, a script's output, one of its past runs). It never
     * writes its `evals/` folder or its memory.
     *
     * Warning: code the agent writes then runs on your machine with the same
     * rights as chloe.
     *
     * Every agent can already read its own files in every turn
     * (`ownListFiles`, `ownReadFile`) and its past runs (`ownListRuns`,
     * `ownReadRun`), and try one of its jobs (`ownTryJob`), in replies to its
     * owner. It does not need this setting for that.
     */
    selfImprovement?: boolean;
  }
}

export const selfImprovement: Plugin = {
  name: "self-improvement",
  abilities: [
    {
      name: "selfImprovement",
      label: "Self improvement",
      on: true,
      does: "Changes its own purpose, skills, jobs and code when you ask it to. Each change is a commit you can undo.",
      tools: ["selfWriteFile"],
      make: (home) => selfWriteTools()(home),
    },
  ],
  async words(agent, reply) {
    if (!abilityOn(agent.abilities, "selfImprovement")) return [];
    const sections = [
      { about: "How you grow", text: howYouGrow(reply) },
      { about: "What you run on", text: await whatYouRunOn(agent, reply) },
      { about: "Changing yourself", text: cannotChange(reply) },
    ];
    return sections.filter((one) => one.text);
  },
};

/**
 * What it is told in every turn but a guest's: that what it cannot do is what
 * it cannot do yet, and that it works by finding a way code can do the work, so
 * the same request asked again is answered by code, the same way every time.
 */
function howYouGrow({ guest }: Reply): string {
  if (guest) return "";
  return (
    "You can learn. When you are asked for something you cannot do, say you cannot do it yet, and what learning " +
    "it would take: a skill, a tool, a connection or a job. You learn by changing yourself, when your owner asks.\n\n" +
    "Your way of working is to find a way code can do the work, so the same request gets the same answer every " +
    "time. That is a habit: a skill whose script does it when asked, or a job in code when it should happen on a " +
    "schedule, asking a model only where it needs judgement. A habit costs a fraction of a turn and answers the " +
    "same tomorrow. Before doing something by hand, look for a skill, script or job of yours that already does it, " +
    "and run that. When you do work by hand that you will be asked for again, or that could be written down as " +
    "rules, offer to make it a habit, and say what it would save."
  );
}

/** The most of its own files an agent is shown by name in its purpose. */
const FILES_SHOWN = 100;

/**
 * What it is told in a turn its owner wrote: its files, the guides and what
 * each covers, to read what a change needs in one call and write it in one
 * more, and that a secret goes in the Keys box, never a chat. Empty for any
 * other turn.
 */
async function whatYouRunOn(agent: Agent, { tools }: Reply): Promise<string> {
  if (!tools.ownReadGuide) return "";
  const { files } = await ownFiles(agent, FILES_SHOWN + 1);
  const shown = files.slice(0, FILES_SHOWN).map((one) => {
    const why = whyNot(agent, one.path);
    return `- ${one.path}${why ? ` (not yours to write: ${why})` : ""}`;
  });
  if (files.length > FILES_SHOWN) shown.push("- and more, which ownListFiles lists");
  const changing = tools.selfWriteFile
    ? "To change yourself, read every file and guide the change needs at once, with one ownReadFile and one " +
      "ownReadGuide call in the same step, then write every file in one selfWriteFile call. Never read them one at " +
      "a time. "
    : "";
  const dashboard = dashboardAddress();
  return (
    "You run on Chloe, and you can be given more than you have now: Gmail, Calendar and Drive, sending mail, " +
    "Telegram, Slack, WhatsApp, email conversations, a chat box on a website, reading web pages, scripts, jobs on a " +
    "schedule. When you are asked for something you cannot do yet, read the guides it needs, then add it to " +
    "yourself or say what your owner has to do for it. " +
    changing +
    "Never ask for a key, password or secret in a chat: send your owner to the dashboard's Configuration page, " +
    `${dashboard}/configuration, which has a form for each setting and key and writes chloe.config.ts and .env without you or ` +
    `the chat seeing a secret. For a key it has no form for, link to ${dashboard}/configuration?key=<the name>. Setting up ` +
    "Google is #google on that page. A setting the forms do not cover goes in chloe.config.ts, which you cannot " +
    "write: say the line and where it goes. A sign-in like Google's is done by Chloe itself, with a link, never by you.\n\n" +
    `### Your files\n\n${shown.join("\n") || "None yet."}\n\n` +
    `### The guides\n\n${guides().map((one) => `- **${one.page}**: ${one.about}`).join("\n")}`
  );
}

/**
 * What it is told in a turn that cannot change it: who can ask for a change,
 * and what to do with a lesson meanwhile. Empty in a turn that can.
 */
function cannotChange({ tools, user }: Reply): string {
  if (Object.values(tools).some((one) => one.changesAgent)) return "";
  // A token's turn is `api:<token id>`. Without this the model guessed why it
  // could not, and told its owner a change would be applied after the turn.
  const where = user?.startsWith("api:")
    ? "This message came through the API, from a program holding a token, and a token never can: they have to ask " +
      "on another of your channels, where they are your owner. "
    : "";
  return (
    "You cannot change your own purpose, skills or jobs in this turn, and nothing changes them for you after it: " +
    "only your owner can ask for that, in a message to you. " +
    where +
    (!tools.memoryEditFile ? "When" : "Keep what you learned in your memory, and when") +
    " it should change one of those files, say which and how in one line, so they can ask."
  );
}
