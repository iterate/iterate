import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import z from "zod";
import { Bash } from "just-bash";
import { match } from "schematch";
import { AgentInputEvent } from "./agent.ts";

const BashmodeBlockAddedEvent = z.object({
  type: z.literal("bashmode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});

export const processor = defineProcessor(() => {
  const bash = new Bash({
    network: {
      dangerouslyAllowFullInternetAccess: true,
      denyPrivateRanges: false,
    },
  });
  return {
    slug: "bashmode",
    afterAppend: async ({ append, event, state, logger }) => {
      await match(event)
        .case(AgentInputEvent, async ({ payload }) => {
          if (payload.role !== "assistant") return;

          // parse ```bash out of payload.content
          const script = payload.content.match(/```bash\n(.*?)\n```/s)?.[1];
          if (!script) return;
          await append({
            event: {
              type: "bashmode-block-added",
              payload: { script },
            },
          });
        })
        .case(BashmodeBlockAddedEvent, async ({ payload }) => {
          const result = await bash.exec(payload.script);
          await append({
            event: {
              type: "agent-input-added",
              payload: {
                role: "user",
                content: [
                  "```",
                  `Bash script completed with exit code ${result.exitCode}.`,
                  `Stdout: ${result.stdout}`,
                  `Stderr: ${result.stderr}`,
                  "```",
                ].join("\n"),
              },
            },
          });
        })
        .defaultAsync(async () => {
          logger.info("Ignoring event", event);
        });
    },
  };
});

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/video",
    includeChildren: true,
    processor,
  }).run();
}
