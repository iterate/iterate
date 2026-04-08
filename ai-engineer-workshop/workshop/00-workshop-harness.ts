import { createEventsClient, os, runIfMain } from "ai-engineer-workshop";

export const handler = os.handler(async ({ context, input }) => {
  const streamPath = `${input.pathPrefix}/00-workshop-harness`;
  const client = createEventsClient();

  const result = await client.append({
    path: streamPath,
    event: { type: "" },
  });

  context.logger.info(JSON.stringify(result, null, 2));
});

runIfMain(import.meta.url, handler);
