// selfWriteFile, the one tool of self improvement: the agent changing files in
// its own folder, as far as `whyNot` allows. It is only in a turn whose owner
// asked and may change it (`changesAgent` in model/tool.ts).
import { tool } from "ai";
import { z } from "zod";

import type { Home } from "#chloe/load/load";
import type { ChloeTool, Tools } from "#chloe/model/tool";
import { changeOwnFiles } from "./changeService.ts";

/** selfWriteFile: changing the agent's own folder, as far as `whyNot` in changeService.ts allows. */
export function selfWriteTools(): (agent: Home) => Tools {
  return (agent) => ({ selfWriteFile: writeTool(agent) });
}

function writeTool(agent: Home): ChloeTool {
  return Object.assign(
    tool({
      description:
        "Change files in your own folder: your purpose, skills, jobs and code. Each replaces the whole file, so read it " +
        "first and include everything you want kept. Give every file one change needs in one call: they are " +
        "written together and committed as one change, with your message. A markdown file directly in skills/ is a " +
        "skill, with name and description at the top: keep it short and about how to do the job, and write down only " +
        "what cost you something, because every run that opens it reads all of it. One directly in jobs/ is a job, " +
        "with cron, description, " +
        "timezone and model at the top, and a job you write runs at most once an hour. Its description says what is " +
        "true when a run is done, not what the job does. " +
        "Your code is yours too: agent.ts, jobs, tools, services, channels, scripts. With code among them you are " +
        "loaded once with all of them, and they are all put back with the reason when you would not load. A new " +
        "job runs once agent.ts names it, so give both. Your evals and your memory are not yours to write here. " +
        "Every change can be seen and undone. " +
        "You have this only when your owner wrote to you, and only in a reply where no other tool has read " +
        "something from outside you (mail, a web page, a script, one of your runs): after that, say what you would " +
        "change and they ask for it in their next message.",
      inputSchema: z.object({
        files: z
          .array(
            z.object({
              path: z.string().describe("A path inside your folder, like skills/deploys.md."),
              content: z.string().min(1).describe("The whole file."),
            }),
          )
          .min(1)
          .max(20),
        message: z.string().min(10).describe("What changed and why, as a commit message."),
      }),
      execute: ({ files, message }) => changeOwnFiles(agent, files, message),
    }),
    { title: "Write file", kind: "write" as const, own: true, forOwner: true, changesAgent: true },
  );
}
