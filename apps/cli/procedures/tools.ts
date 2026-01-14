import { z } from "zod/v4";
import { t } from "../trpc.ts";

export const toolsRouter = t.router({
  sendSlackMessage: t.procedure
    .meta({ description: "Send a message to Slack" })
    .input(
      z.object({
        channel: z.string().describe("Slack channel (e.g. #general)"),
        message: z.string().describe("Message text to send"),
        threadTs: z.string().optional().describe("Thread timestamp for replies"),
      }),
    )
    .mutation(({ input }) => {
      // TODO: implement real Slack integration
      console.log(`[DUMMY] Would send to ${input.channel}: ${input.message}`);
      return {
        success: true,
        channel: input.channel,
        message: input.message,
        ts: Date.now().toString(),
      };
    }),

  sendEmail: t.procedure
    .meta({ description: "Send an email" })
    .input(
      z.object({
        to: z.string().describe("Recipient email address"),
        subject: z.string().describe("Email subject"),
        body: z.string().describe("Email body"),
      }),
    )
    .mutation(({ input }) => {
      // TODO: implement real email sending
      console.log(`[DUMMY] Would send email to ${input.to}: ${input.subject}`);
      return {
        success: true,
        to: input.to,
        subject: input.subject,
        messageId: `msg-${Date.now()}`,
      };
    }),
});
