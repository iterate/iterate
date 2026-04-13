import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import { z } from "zod";
import { Bash } from "just-bash";
import { AgentInputAddedEvent } from "./stream.ts";

const BashmodeBlockAddedEvent = z.object({
  type: z.literal("bashmode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});

const bashmodeProcessor = defineProcessor(() => {
  const bash = new Bash({
    network: {
      dangerouslyAllowFullInternetAccess: true,
      denyPrivateRanges: false,
    },
  });

  return {
    slug: "bashmode",
    afterAppend: async ({ append, event }) => {
      if (event.type === "agent-input-added") {
        const typedEvent = AgentInputAddedEvent.parse(event);
        if (typedEvent.payload.role === "assistant") {
          const script =
            typedEvent.payload.content.match(/```bash\s*([\s\S]*?)```/)?.[1]?.trim() ?? null;
          if (script) {
            await append({
              event: {
                type: "bashmode-block-added",
                payload: { script },
              },
            });
          }
        }
      }
      if (event.type === "bashmode-block-added") {
        const typedEvent = BashmodeBlockAddedEvent.parse(event);
        const result = await bash.exec(typedEvent.payload.script);
        await append({
          event: {
            type: "agent-input-added",
            payload: {
              role: "user",
              content: [
                "```",
                `Bash exited with code ${result.exitCode}.`,
                `Stdout: ${result.stdout}`,
                `Stderr: ${result.stderr}`,
                "```",
              ].join("\n"),
            },
          },
        });
      }
    },
  };
});

export default bashmodeProcessor;

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/video",
    includeChildren: true,
    processor: bashmodeProcessor,
  }).run();
}
