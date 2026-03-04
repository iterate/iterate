import { z } from "zod/v4";
import { publicProcedure } from "../orpc/init.ts";

const DAEMON_PORT = process.env.PORT ?? "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;
const AGENT_PATH = "/system/pull-iterate-iterate";

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

      const prompt = [
        `Use the skill at .opencode/skills/pull-iterate-iterate/SKILL.md to pull the iterate/iterate repo to ref: ${ref}`,
        "",
        "Follow every step in the skill. Do not skip the process restarts at the end.",
      ].join("\n");

      await sendPromptToAgent(AGENT_PATH, prompt);

      return {
        triggered: true,
        ref,
        agentPath: AGENT_PATH,
      };
    }),
};
