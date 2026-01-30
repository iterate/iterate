import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import dedent from "dedent";
import { LogLevel, WebClient } from "@slack/web-api";
import { Resend } from "resend";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

// add debug logging by default so that agents always see the message_ts info etc. when they send messages
function getSlackClient(logLevel: LogLevel = LogLevel.DEBUG) {
  const token = process.env.ITERATE_SLACK_ACCESS_TOKEN;
  if (!token) throw new Error("ITERATE_SLACK_ACCESS_TOKEN environment variable is required");
  return new WebClient(token, { logLevel });
}

function getResendClient() {
  const apiKey = process.env.ITERATE_RESEND_API_KEY;
  if (!apiKey) throw new Error("ITERATE_RESEND_API_KEY environment variable is required");
  return new Resend(apiKey);
}

export const toolsRouter = t.router({
  slack: t.procedure
    .meta({ description: "Run arbitrary Slack API code" })
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
        const fromAddress = process.env.ITERATE_RESEND_FROM_ADDRESS;
        if (!fromAddress) {
          throw new Error("Failed to get from addresss from env.ITERATE_RESEND_FROM_ADDRESS");
        }

        const splitEmails = (emails: string) => {
          const list = emails.split(",");
          return list.map((e) => e.trim()).filter(Boolean);
        };
        const { data, error } = await client.emails.send({
          from: `Iterate Agent <${fromAddress}>`,
          to: splitEmails(input.to),
          cc: splitEmails(input.cc || ""),
          bcc: splitEmails(input.bcc || ""),
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
  printenv: t.procedure
    .meta({ description: "List environment variables from ~/.iterate/.env" })
    .input(z.object({}).optional())
    .query(() => {
      const envFilePath = join(homedir(), ".iterate/.env");
      let content: string;
      try {
        content = readFileSync(envFilePath, "utf-8");
      } catch (error) {
        return {
          success: false,
          error: `Failed to read ${envFilePath}: ${error instanceof Error ? error.message : String(error)}`,
          activeEnvVars: [],
          recommendedEnvVars: [],
        };
      }

      const lines = content.split("\n");
      type EnvVar = { name: string; description?: string };
      const activeEnvVars: EnvVar[] = [];
      const recommendedEnvVars: EnvVar[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Look for description in previous line (comment)
        const getDescription = (): string | undefined => {
          if (i > 0) {
            const prevLine = lines[i - 1]?.trim();
            if (prevLine?.startsWith("#") && !prevLine.startsWith("#[")) {
              return prevLine.replace(/^#\s*/, "");
            }
          }
          return undefined;
        };

        // Match recommended env vars: #[recommended] FOO_BAR="..."
        const recommendedMatch = line.match(/^#\[recommended\]\s*([A-Z][A-Z0-9_]*)=/);
        if (recommendedMatch) {
          recommendedEnvVars.push({ name: recommendedMatch[1], description: getDescription() });
          continue;
        }

        // Match active env vars: FOO_BAR="..." (not commented)
        const activeMatch = line.match(/^([A-Z][A-Z0-9_]*)=/);
        if (activeMatch) {
          activeEnvVars.push({ name: activeMatch[1], description: getDescription() });
          continue;
        }
      }

      return {
        success: true,
        activeEnvVars,
        recommendedEnvVars,
        envFilePath,
      };
    }),
});
