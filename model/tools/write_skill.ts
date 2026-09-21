// An agent rewriting one of its own skills.
//
// This is the self-improving part, and it is deliberately the only part. A
// skill is markdown: when to do something, which script does it, and what the
// output means. An agent that learns something about its own job can put it
// where the next run will read it, and the change is live in about fifteen
// seconds with no restart.
//
// What an agent may NOT write is its tools and its scripts/ folder. Those are
// code, and code it writes is code it then runs as itself. A skill can only
// point at a script that a person already put there.
//
// Every write is a git commit, so self-improvement always leaves a diff.
import { writeIn } from "./files.ts";
import { agentDir } from "#chloe/core/paths.ts";
import type { Tools } from "../tool.ts";

/** A tool that rewrites one of the agent's own skills. Every write is a commit. */
export function writeSkill(agent: string) {
  return writeIn({
    root: `${agentDir(agent)}/skills`,
    what: "your own skills",
    id: "write_skill",
    commit: true,
  });
}

/** write_skill: the agent rewrites its own skills, and every write is a commit. */
export function selfImprovement(): (agent: { name: string }) => Tools {
  return ({ name }) => ({ write_skill: writeSkill(name) });
}
