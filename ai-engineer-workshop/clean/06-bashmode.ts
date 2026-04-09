import { defineProcessor } from "ai-engineer-workshop";
import { Bash } from "just-bash";
import { z } from "zod";
import { PullProcessorRuntime } from "ai-engineer-workshop";
import dedent from "dedent";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import {
  OpenAiResponseEventAdded,
  AgentInputAdded,
} from "./04-with-openai-request-with-history.ts";

const prompt = `
You can execute bash code on your computer. All you have to do is put the code in 

\`\`\`bash
echo "Hello world" > hello.txt
\`\`\`

This is the main way you interact with the world. Use it to research the web, read files, and more.

### Messaging other agents

You can use curl to message other agents. For example if your path is /jonas/hello-world, you can
create a sub-agent 

\`\`\`bash
curl --json '{"type": "ping"}' https://events.iterate.com/api/streams/:path
\`\`\`
`;

export const BashmodeBlockAdded = z.object({
  type: z.literal("bashmode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});

export const bashmodeProcessor = defineProcessor(() => {
  const bash = new Bash({
    network: {
      dangerouslyAllowFullInternetAccess: true,
    },
  });
  return {
    slug: "bashmode",
    afterAppend: async ({ append, event }) => {
      if (event.type === "agent-output-added") {
        const typedEvent = OpenAiResponseEventAdded.parse(event);
        const script = extractBashBlocks(typedEvent.payload);
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
        const result = await bash.exec(typedEvent.payload.script);
        await append({
          event: AgentInputAdded.parse({
            type: "agent-input-added",
            payload: {
              role: "developer",
              content: [
                `Bash exited with code ${result.exitCode}.`,
                "```",
                `Stdout: ${result.stdout}`,
                `Stderr: ${result.stderr}`,
                "```",
              ].join("\n"),
            },
          }),
        });
      }
    },
  };
});

function extractBashBlocks(event: ResponseStreamEvent) {
  if (event.type !== "response.output_text.done") return null;
  return event.text.match(/```(?:bash|sh|shell)\s*([\s\S]*?)```/)?.[1]?.trim() || null;
}

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/jonas",
    processor: bashmodeProcessor,
  }).run();
}
