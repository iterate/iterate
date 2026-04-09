import { createEventsClient, defineProcessor } from "ai-engineer-workshop";
import dedent from "dedent";
import { Bash } from "just-bash";
import type { ResponseCompletedEvent } from "openai/resources/responses/responses.mjs";

const client = createEventsClient();
const path = "/jonas/hello-world";

const bash = new Bash({
  network: {
    dangerouslyAllowFullInternetAccess: true,
  },
});

const bashmode = defineProcessor(() => {
  return {
    slug: "bashmode",
    afterAppend: async ({ append, event }) => {
      if (event.type === "bashmode-block-added") {
        const result = await bash.exec(event.payload.content);
        await append({
          event: {
            type: "agent-input-added",
            payload: {
              content: JSON.stringify(result, null, 2),
            },
          },
        });
      }

      await handleEvent(event as StreamEvent, async (nextEvent) => {
        await append({ event: nextEvent });
      });
    },
  };
});

let eventCount = 0;
for await (const _event of await client.stream({
  path,
  after: "start",
  before: "end",
})) {
  eventCount++;
}
console.log("Caught up with history");

for await (const event of await client.stream({
  path,
  after: eventCount,
})) {
  console.log("Event appended", JSON.stringify(event, null, 2));
  await handleEvent(event as StreamEvent, async (nextEvent) => {
    await client.append({
      path,
      event: nextEvent,
    });
  });
}

function extractBashBlocks(event: ResponseCompletedEvent) {
  return event.response.output
    .filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content)
    .filter((item) => item.type === "output_text")
    .flatMap((item) =>
      [...item.text.matchAll(/```(?:bash|sh|shell)\s*([\s\S]*?)```/g)]
        .map((match) => match[1]?.trim())
        .filter((content): content is string => Boolean(content)),
    );
}

void bashmode;
