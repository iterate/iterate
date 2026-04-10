import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import { z } from "zod";
import { x } from "tinyexec";
import { InputItem } from "./agent-processor.ts";

export const BashmodeBlockAdded = z.object({
  type: z.literal("bashmode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});

export const bashmodeProcessor = defineProcessor(() => ({
  slug: "bashmode",
  afterAppend: async ({ append, event }) => {
    if (event.type === "agent-output-added") {
      const payload = InputItem.parse(event.payload);
      const script = payload.content.match(/```bash\s*([\s\S]*?)```/)?.[1]?.trim() ?? null;
      if (script) {
        await append({
          event: {
            type: "bashmode-block-added",
            payload: { script },
          },
        });
      }
    }

    if (event.type === "bashmode-block-added") {
      const typedEvent = BashmodeBlockAdded.parse(event);
      const result = await x("bash", ["-lc", typedEvent.payload.script]);
      await append({
        event: {
          type: "agent-input-added",
          payload: {
            role: "developer",
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
}));

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/jonas",
    processor: bashmodeProcessor,
  }).run();
}
