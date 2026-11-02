// A few things to ask an agent, under an empty chat box. Read off what has
// been talked about, or else off what the agent has turned on: no model is
// asked. No React.
import type { AgentSummary, Group, Thread } from "./types.ts";

/** Whether the agent has a tool from this ability, like "abilities.memory". */
const turnedOn = (agent: AgentSummary, ability: string) => Object.values(agent.toolsFrom ?? {}).includes(ability);

/** What to suggest for each thing an agent may have. A channel is matched by the start of its name. */
const FOR: { has: (agent: AgentSummary) => boolean; say: (agent: AgentSummary) => string[] }[] = [
  {
    has: () => true,
    say: () => ["What can you do?"],
  },
  {
    has: (agent) => turnedOn(agent, "abilities.memory"),
    say: () => ["Remember that I like short answers.", "What have you written down so far?"],
  },
  {
    has: (agent) => turnedOn(agent, "abilities.selfImprovement"),
    say: () => [
      "Add a job that checks on something for me every weekday at 9.",
      "Change your purpose so you answer in one paragraph.",
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
    has: (agent) => agent.channels.some((name) => name.startsWith("discord")),
    say: () => ["Message me on Discord when a job needs an answer."],
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
  const writes = turnedOn(agent, "abilities.selfImprovement");
  return [...(writes ? [A_JOB] : []), ...all].slice(0, few);
}

/** A name without the emoji or marks in front of it, so it reads inside a sentence. */
const bare = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, "").trim();

/**
 * Up to `few` that follow on from what has been talked about: the newest
 * conversations somebody named, then the groups. A conversation never named is
 * left out, since the name it started with is an address, not a subject. Empty
 * for an agent with nothing named yet.
 */
export function ideasFrom(threads: Thread[], groups: Group[], few = 3): string[] {
  const named = threads
    .filter((one) => one.label && !one.archived)
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((one) => bare(one.label as string))
    .filter(Boolean);
  const said = [
    ...named.slice(0, few - Math.min(1, groups.length)).map((name) => `What is left to do on ${name}?`),
    ...groups.map((group) => bare(group.name)).filter(Boolean).map((name) => `What should I do next in ${name}?`),
  ];
  return [...new Set(said)].slice(0, few);
}
