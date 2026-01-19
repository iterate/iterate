import { createRequire } from "node:module";
import dedent from "dedent";
import { WebClient } from "@slack/web-api";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

function getSlackClient() {
  const token = process.env.ITERATE_SLACK_ACCESS_TOKEN;
  if (!token) throw new Error("ITERATE_SLACK_ACCESS_TOKEN environment variable is required");
  return new WebClient(token);
}

export const toolsRouter = t.router({
  slack: t.procedure
    .input(
      z.object({
        code: z.string().meta({ positional: true }).describe(dedent`
          An JavaScript script that uses a slack client named \`slack\`. For example:

          await slack.chat.postMessage({
            channel: "C1234567890",
            text: "Hello, world!",
          });

          await slack.reactions.add({
            channel: "C1234567890",
            timestamp: "1234567890.123456",
            name: "thumbsup",
          });
        `),
      }),
    )
    .mutation(async ({ input }) => {
      const require = createRequire(import.meta.url);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const _execute = new AsyncFunction("slack", "require", input.code);
      const result = await _execute(getSlackClient(), require);
      return result;
    }),
  sendSlackMessage: t.procedure
    .meta({ description: "Send a message to Slack" })
    .input(
      z.object({
        channel: z.string().describe("Slack channel (e.g. #general or C1234567890)"),
        message: z.string().describe("Message text to send"),
        threadTs: z.string().optional().describe("Thread timestamp for replies"),
      }),
    )
    .mutation(async ({ input }) => {
      const client = getSlackClient();
      const result = await client.chat.postMessage({
        channel: input.channel,
        text: input.message,
        thread_ts: input.threadTs,
      });

      return {
        success: result.ok,
        channel: result.channel,
        ts: result.ts,
        message: input.message,
      };
    }),
});
