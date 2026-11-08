// Self improvement: an agent changing its own purpose, skills, jobs and code
// when its owner asks, each change a commit a person can undo. Its one tool is
// selfWriteFile; the rest is what the agent is told about changing itself.
import { abilityOn } from "#chloe/load/abilities";
import type { Plugin, Reply } from "#chloe/load/plugin";
import { dashboardAddress } from "#chloe/core/turn";
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
  words(agent, reply) {
    if (!abilityOn(agent.abilities, "selfImprovement")) return [];
    const sections = [
      { about: "How you grow", text: howYouGrow(reply) },
      { about: "What you run on", text: whatYouRunOn(reply) },
      { about: "Changing yourself", text: cannotChange(reply) },
    ];
    return sections.filter((one) => one.text);
  },
};

/**
 * What it is told in every turn but a guest's: that what it cannot do is what
 * it cannot do yet, and that work done the same way again can become a habit
 * in code. Kept to two sentences because it is in every conversation: at more
 * length it pulls a chat about anything toward an offer to automate it.
 */
function howYouGrow({ guest }: Reply): string {
  if (guest) return "";
  return (
    "What you cannot do, you cannot do yet: say so, and what learning it would take (a skill, a tool, a connection " +
    "or a job), which you learn by changing yourself when your owner asks. Work you do the same way again and again " +
    "can become a habit, a skill's script or a job in code that answers the same every time: when a task you finish " +
    "is like that, offer to make it a habit, in one line at the end, and look for one you already have before doing " +
    "such work by hand."
  );
}

/**
 * What it is told in a turn its owner wrote: where to look before changing
 * itself, and that a secret goes in the Configuration page, never a chat.
 * Its files and the guides are not listed here: `ownListFiles` lists the
 * files, and `ownReadGuide` carries the list of guides. Empty for any other
 * turn.
 */
function whatYouRunOn({ tools }: Reply): string {
  if (!tools.ownReadGuide) return "";
  const changing = tools.selfWriteFile
    ? "To change yourself, list your files, then read every file and guide the change needs at once, with one " +
      "ownReadFile and one ownReadGuide call in the same step, and write every file in one selfWriteFile call. "
    : "";
  const dashboard = dashboardAddress();
  return (
    "You run on Chloe, and you can be given more than you have now: connections like Gmail, channels like Telegram, " +
    "web pages, scripts and jobs on a schedule. When you are asked for something you cannot do yet, or to change " +
    "yourself, read the guides it needs first, then add it or say what your owner has to do. " +
    changing +
    "Never ask for a key, password or secret in a chat: send your owner to " +
    `${dashboard}/configuration, which has a form for each setting and key, or ${dashboard}/configuration?key=<the name> ` +
    "for a key it has no form for. A setting the forms do not cover goes in chloe.config.ts, which you cannot write: " +
    "say the line and where it goes. A sign-in like Google's is done by Chloe itself, with a link, never by you."
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
