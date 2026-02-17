import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { LogLevel, WebClient } from "@slack/web-api";
import dedent from "dedent";
import Replicate from "replicate";
import { Resend } from "resend";
import { z } from "zod/v4";
import { createTRPCRouter, publicProcedure } from "../init.ts";

interface WebchatAttachment {
  fileName: string;
  filePath: string;
  mimeType?: string;
  size?: number;
}

interface WebchatClient {
  postMessage(params: {
    threadId: string;
    text?: string;
    attachments?: WebchatAttachment[];
  }): Promise<{ success: boolean; threadId: string; messageId: string; eventId: string }>;
  addReaction(params: {
    threadId: string;
    messageId: string;
    reaction: string;
  }): Promise<{ success: boolean; eventId: string }>;
  removeReaction(params: {
    threadId: string;
    messageId: string;
    reaction: string;
  }): Promise<{ success: boolean; eventId: string }>;
  getThreadMessages(params: { threadId: string }): Promise<{
    threadId: string;
    messages: Array<{
      threadId: string;
      messageId: string;
      role: string;
      text: string;
      createdAt: number;
    }>;
  }>;
  listThreads(): Promise<{
    threads: Array<{
      threadId: string;
      title: string;
      messageCount: number;
      lastMessageAt: number;
    }>;
  }>;
}

function getSlackClient(logLevel: LogLevel = LogLevel.DEBUG) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN environment variable is required");
  }
  return new WebClient(token, { logLevel });
}

function getResendClient() {
  const apiKey = process.env.ITERATE_RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("ITERATE_RESEND_API_KEY environment variable is required");
  }
  return new Resend(apiKey);
}

function getReplicateClient() {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN environment variable is required");
  }
  return new Replicate({ auth: token });
}

function getWebchatClient(): WebchatClient {
  const baseUrl = "http://localhost:3001/api/integrations/webchat";

  async function post(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Webchat API error ${response.status}: ${text}`);
    }
    return response.json();
  }

  async function get(path: string) {
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Webchat API error ${response.status}: ${text}`);
    }
    return response.json();
  }

  return {
    postMessage: (params) => post("/postMessage", params),
    addReaction: (params) => post("/addReaction", params),
    removeReaction: (params) => post("/removeReaction", params),
    getThreadMessages: (params) => get(`/threads/${encodeURIComponent(params.threadId)}/messages`),
    listThreads: () => get("/threads"),
  };
}

export const toolsRouter = createTRPCRouter({
  slack: publicProcedure
    .meta({ description: "Run arbitrary Slack API code" })
    .input(
      z.object({
        code: z.string().meta({ positional: true }).describe(dedent`
          A JavaScript script that uses a Slack client named \`slack\`. For example:

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
      const execute = new AsyncFunction("slack", "require", input.code);
      const result = await execute(getSlackClient(), require);
      return result;
    }),

  sendSlackMessage: publicProcedure
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

  email: createTRPCRouter({
    reply: publicProcedure
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
          throw new Error("Failed to get from address from env.ITERATE_RESEND_FROM_ADDRESS");
        }

        const splitEmails = (emails: string) => {
          return emails
            .split(",")
            .map((email) => email.trim())
            .filter(Boolean);
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

  replicate: publicProcedure
    .meta({ description: "Run AI models via Replicate API" })
    .input(
      z.object({
        code: z.string().meta({ positional: true }).describe(dedent`
          A JavaScript script that uses a Replicate client named \`replicate\`. For example:

          const output = await replicate.run("black-forest-labs/flux-schnell", {
            input: { prompt: "a photo of a cat" },
          });

          console.log(output);
        `),
      }),
    )
    .mutation(async ({ input }) => {
      const require = createRequire(import.meta.url);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const execute = new AsyncFunction("replicate", "require", input.code);
      const result = await execute(getReplicateClient(), require);
      return result;
    }),

  webchat: publicProcedure
    .meta({ description: "Run webchat API code" })
    .input(
      z.object({
        code: z.string().meta({ positional: true }).describe(dedent`
          A JavaScript script that uses a webchat client named \`webchat\`. For example:

          await webchat.postMessage({
            threadId: "THREAD_ID",
            text: "Hello from the agent!",
          });

          await webchat.addReaction({
            threadId: "THREAD_ID",
            messageId: "MESSAGE_ID",
            reaction: "eyes",
          });
        `),
      }),
    )
    .mutation(async ({ input }) => {
      const require = createRequire(import.meta.url);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const execute = new AsyncFunction("webchat", "require", input.code);
      const result = await execute(getWebchatClient(), require);
      return result;
    }),

  printenv: publicProcedure
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

      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        const getDescription = (): string | undefined => {
          if (index > 0) {
            const previous = lines[index - 1]?.trim();
            if (previous?.startsWith("#") && !previous.startsWith("#[")) {
              return previous.replace(/^#\s*/, "");
            }
          }
          return undefined;
        };

        const recommendedMatch = line.match(/^#\[recommended\]\s*([A-Z][A-Z0-9_]*)=/);
        if (recommendedMatch) {
          recommendedEnvVars.push({ name: recommendedMatch[1], description: getDescription() });
          continue;
        }

        const activeMatch = line.match(/^([A-Z][A-Z0-9_]*)=/);
        if (activeMatch) {
          activeEnvVars.push({ name: activeMatch[1], description: getDescription() });
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
