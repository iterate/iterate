import { WebClient } from "@slack/web-api";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

function getSlackClient() {
  const token = process.env.SLACK_ACCESS_TOKEN;
  if (!token) throw new Error("SLACK_ACCESS_TOKEN environment variable is required");
  return new WebClient(token);
}

export const toolsRouter = t.router({
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
