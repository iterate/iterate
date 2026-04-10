import { Bash } from "just-bash";
import dedent from "dedent";
import { defineProcessor } from "ai-engineer-workshop";
import { match } from "schematch";
import { z } from "zod";
import {
  OpenAiAssistantMessageOutput,
  OpenAiOutputText,
  OpenAiResponseCompletedPayload,
  OpenAiResponseEventAddedEvent,
} from "./agent-processor.ts";

export const BashmodeBlockAddedEvent = z.object({
  type: z.literal("bashmode-block-added"),
  payload: z.object({
    content: z.string().min(1),
  }),
});

export const BashmodeBlockAddedEventInput = BashmodeBlockAddedEvent;

const bashmode = defineProcessor(() => {
  const bash = new Bash({
    env: {
      BASE_URL: process.env.BASE_URL || "https://events.iterate.com",
      PROJECT_SLUG: process.env.PROJECT_SLUG || "public",
    },
    network: {
      dangerouslyAllowFullInternetAccess: true,
    },
  });

  return {
    slug: "bashmode",
    afterAppend: async ({ append, event }) => {
      await match(event)
        .case(BashmodeBlockAddedEvent, async ({ payload }) => {
          const result = await bash.exec(payload.content);

          await append({
            event: {
              type: "agent-input-added",
              payload: {
                content: dedent`
                  Bash result:
                  stdout:
                  ${result.stdout}
                  stderr:
                  ${result.stderr}
                  exitCode: ${result.exitCode}
                `,
              },
            },
          });
        })
        .case(OpenAiResponseEventAddedEvent, async ({ payload }) => {
          const completedResponse = OpenAiResponseCompletedPayload.safeParse(payload);
          if (!completedResponse.success) return;

          for (const outputItem of completedResponse.data.response.output) {
            const assistantMessage = OpenAiAssistantMessageOutput.safeParse(outputItem);
            if (!assistantMessage.success) continue;

            for (const contentItem of assistantMessage.data.content) {
              const outputText = OpenAiOutputText.safeParse(contentItem);
              if (!outputText.success) continue;

              for (const match of outputText.data.text.matchAll(
                /```(?:bash|sh|shell)\s*([\s\S]*?)```/g,
              )) {
                const content = match[1]?.trim();
                if (!content) continue;

                await append({
                  event: {
                    type: "bashmode-block-added",
                    payload: { content },
                  },
                });
              }
            }
          }
        })
        .default(() => undefined);
    },
  };
});

export default bashmode;
