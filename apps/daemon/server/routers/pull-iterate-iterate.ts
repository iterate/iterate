import * as path from "node:path";
import * as fs from "node:fs";
import { z } from "zod/v4";
import { publicProcedure } from "../orpc/init.ts";

const DAEMON_PORT = process.env.PORT ?? "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;
const getAgentPath = (suffix: string) => "/system/pull-iterate-iterate/" + suffix;

async function sendPromptToAgent(agentPath: string, message: string): Promise<void> {
  const response = await fetch(`${DAEMON_BASE_URL}/api/agents${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [{ type: "iterate:agent:prompt-added", message }] }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Agent prompt failed: ${response.status}${errorBody ? ` ${errorBody.slice(0, 500)}` : ""}`,
    );
  }
}

export const pullIterateIterateRouter = {
  pullIterateIterate: publicProcedure
    .input(
      z.object({
        ref: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const ref = input.ref ?? "main";

      let repoRoot = import.meta.dirname;
      while (repoRoot && !fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) {
        repoRoot = path.dirname(repoRoot);
        if (repoRoot === "/") break;
      }
      const skillPath = path.join(repoRoot, ".opencode/skills/pull-iterate-iterate/SKILL.md");
      const prompt = [
        `Use the skill at ${skillPath} to pull the iterate/iterate repo to ref: ${ref}`,
        "",
        "Follow every step in the skill. Do not skip the process restarts at the end.",
      ].join("\n");

      const agentPath = getAgentPath(`${ref}/${Date.now()}`);
      await sendPromptToAgent(agentPath, prompt);

      return { triggered: true, ref, agentPath };
    }),
};
