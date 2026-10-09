// A few things to ask an agent, under an empty chat box. Read off what the
// agent has turned on, from fixed lists: no model is asked. No React.
import type { AgentSummary } from "./types.ts";

/** Whether the agent has a tool from this feature, like "features.memory". */
const turnedOn = (agent: AgentSummary, feature: string) => Object.values(agent.toolsFrom ?? {}).includes(feature);

/** What to suggest for each thing an agent may have. A channel is matched by the start of its name. */
const FOR: { has: (agent: AgentSummary) => boolean; say: (agent: AgentSummary) => string[] }[] = [
  {
    has: () => true,
    say: () => ["What can you do?"],
  },
  {
    has: (agent) => turnedOn(agent, "features.memory"),
    say: () => ["Remember that I like short answers.", "What have you written down so far?"],
  },
  {
    has: (agent) => turnedOn(agent, "features.selfImprovement"),
    say: () => [
      "Add a job that checks on something for me every weekday at 9.",
      "Change your instructions so you answer in one paragraph.",
      "Write yourself a skill for how I like things explained.",
    ],
  },
  {
    has: (agent) => agent.jobs.some((job) => !job.channels),
    say: (agent) => agent.jobs.filter((job) => !job.channels).map((job) => `What does ${job.id} do, and when did it last run?`),
  },
  {
    has: (agent) => agent.channels.some((name) => name.startsWith("telegram")),
    say: () => ["Message me on Telegram when a job finishes."],
  },
  {
    has: (agent) => agent.channels.some((name) => name.startsWith("slack")),
    say: () => ["Post in Slack when something needs me."],
  },
  {
    has: (agent) => agent.channels.some((name) => name.startsWith("whatsapp")),
    say: () => ["Send me a WhatsApp message when a job needs an answer."],
  },
  {
    has: (agent) => agent.channels.some((name) => name.startsWith("email")),
    say: () => ["Start an email conversation with me about this."],
  },
  {
    has: (agent) => agent.channels.some((name) => name.startsWith("web")),
    say: () => ["What will a visitor on my site be able to ask you?"],
  },
  {
    has: (agent) => agent.api,
    say: () => ["How can another system start one of your jobs?"],
  },
];

/**
 * A whole job, shown first whenever the agent may write one: code fetches the
 * news, one model step picks and sums it up, code sends the email.
 */
const A_JOB = "Write a job that reads the news for my city every morning at 7, has a model pick the good stories, and emails them to me.";

/** Up to `few` of them, none twice, the job first when it fits and the rest in no order. `random` is there for the tests. */
export function ideasFor(agent: AgentSummary, few = 3, random: () => number = Math.random): string[] {
  const all = [...new Set(FOR.filter((one) => one.has(agent)).flatMap((one) => one.say(agent)))];
  for (let at = all.length - 1; at > 0; at--) {
    const other = Math.floor(random() * (at + 1));
    [all[at], all[other]] = [all[other], all[at]];
  }
  const writes = turnedOn(agent, "features.selfImprovement");
  return [...(writes ? [A_JOB] : []), ...all].slice(0, few);
}
