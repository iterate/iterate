import { createRequire } from "node:module";
import dedent from "dedent";
import { WebClient } from "@slack/web-api";
import { Resend } from "resend";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

function getSlackClient() {
  const token = process.env.ITERATE_SLACK_ACCESS_TOKEN;
  if (!token) throw new Error("ITERATE_SLACK_ACCESS_TOKEN environment variable is required");
  return new WebClient(token);
}

function getResendClient() {
  const apiKey = process.env.ITERATE_RESEND_API_KEY;
  if (!apiKey) throw new Error("ITERATE_RESEND_API_KEY environment variable is required");
  return new Resend(apiKey);
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
  email: t.router({
    reply: t.procedure
      .meta({ description: "Send an email reply" })
      .input(
        z.object({
          to: z
            .string()
            .describe("Recipient email address. Comma separated for multiple recipients."),
          cc: z.string().optional().describe("Comma separated list of CC emails"),
          bcc: z.string().optional().describe("Comma separated list of BCC emails"),
          subject: z.string().describe("Email subject (use Re: prefix for replies)"),
          body: z.string().describe("Plain text email body"),
          html: z.string().optional().describe("Optional HTML email body"),
        }),
      )
      .mutation(async ({ input }) => {
        const client = getResendClient();
        const fromAddress = process.env.ITERATE_RESEND_FROM_ADDRESS || "agent@alpha.iterate.com";

        const { data, error } = await client.emails.send({
          from: `Iterate Agent <${fromAddress}>`,
          to: input.to.split(",").map((e) => e.trim()),
          cc: input.cc?.split(",").map((e) => e.trim()),
          bcc: input.bcc?.split(",").map((e) => e.trim()),
          subject: input.subject,
          text: input.body,
          html: input.html,
        });

        if (error) {
          throw new Error(`Failed to send email: ${error.message}`);
        }

        return {
          success: true,
          emailId: data!.id,
          to: input.to,
          subject: input.subject,
        };
      }),
  }),
});
