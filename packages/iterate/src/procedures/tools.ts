import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import dedent from "dedent";
import { LogLevel, WebClient } from "@slack/web-api";
import Replicate from "replicate";
import { Resend } from "resend";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

function lazy<T>(factory: () => T): () => T {
  let initialized = false;
  let value: T;

  return () => {
    if (!initialized) {
      value = factory();
      initialized = true;
    }

    return value;
  };
}

function createLazyClientProxy<TClient extends object>(resolveClient: () => TClient): TClient {
  return new Proxy({} as TClient, {
    get(_target, property) {
      const client = resolveClient();
      const value = Reflect.get(client as object, property, client);

      if (typeof value === "function") {
        return value.bind(client);
      }

      return value;
    },
    set(_target, property, value) {
      return Reflect.set(resolveClient() as object, property, value);
    },
    has(_target, property) {
      return property in resolveClient();
    },
    ownKeys() {
      return Reflect.ownKeys(resolveClient() as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      return Object.getOwnPropertyDescriptor(resolveClient() as object, property);
    },
  });
}

function getSlackClient(logLevel: LogLevel = LogLevel.DEBUG): WebClient {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN environment variable is required");
  }
  return new WebClient(token, { logLevel });
}

function getResendClient(): Resend {
  const apiKey = process.env.ITERATE_RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("ITERATE_RESEND_API_KEY environment variable is required");
  }
  return new Resend(apiKey);
}

function getReplicateClient(): Replicate {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN environment variable is required");
  }
  return new Replicate({ auth: token });
}

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

function getWebchatClient(): WebchatClient {
  const baseUrl = "http://localhost:3001/api/integrations/webchat";

  const post = async (path: string, body: Record<string, unknown>) => {
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
  };

  const get = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Webchat API error ${response.status}: ${text}`);
    }

    return response.json();
  };

  return {
    postMessage: (params) => post("/postMessage", params),
    addReaction: (params) => post("/addReaction", params),
    removeReaction: (params) => post("/removeReaction", params),
    getThreadMessages: (params) => get(`/threads/${encodeURIComponent(params.threadId)}/messages`),
    listThreads: () => get("/threads"),
  };
}

type SendEmailInput = {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
};

function splitEmailList(input: string | string[] | undefined): string[] {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input.map((email) => email.trim()).filter(Boolean);
  }

  return input
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

interface ExecutionContext {
  readonly slack: WebClient;
  readonly resend: Resend;
  readonly replicate: Replicate;
  readonly webchat: WebchatClient;
  readonly env: NodeJS.ProcessEnv;
  sendEmail(input: SendEmailInput): Promise<{ id: string | null }>;
}

function createExecutionContext(): ExecutionContext {
  const resolveSlack = lazy(() => getSlackClient());
  const resolveResend = lazy(() => getResendClient());
  const resolveReplicate = lazy(() => getReplicateClient());
  const resolveWebchat = lazy(() => getWebchatClient());

  return {
    get slack() {
      return resolveSlack();
    },
    get resend() {
      return resolveResend();
    },
    get replicate() {
      return resolveReplicate();
    },
    get webchat() {
      return resolveWebchat();
    },
    env: process.env,
    async sendEmail(input) {
      const defaultFromAddress = process.env.ITERATE_RESEND_FROM_ADDRESS;
      const from =
        input.from ?? (defaultFromAddress ? `Iterate Agent <${defaultFromAddress}>` : undefined);

      if (!from) {
        throw new Error(
          "ITERATE_RESEND_FROM_ADDRESS environment variable is required unless you pass `from`",
        );
      }

      const { data, error } = await resolveResend().emails.send({
        from,
        to: splitEmailList(input.to),
        cc: splitEmailList(input.cc),
        bcc: splitEmailList(input.bcc),
        subject: input.subject,
        text: input.text,
        html: input.html,
      });

      if (error) {
        throw new Error(`Failed to send email: ${error.message}`);
      }

      return { id: data?.id ?? null };
    },
  };
}

export const toolsRouter = t.router({
  execJs: t.procedure
    .meta({
      description:
        "Run JavaScript with execution context (lazy clients: slack, resend, replicate, webchat)",
    })
    .input(
      z.object({
        code: z.string().meta({ positional: true }).describe(dedent`
          JavaScript script.

          Top-level vars (lazy clients):

          - \`slack\` (@slack/web-api WebClient)
          - \`resend\` (Resend API client)
          - \`replicate\` (Replicate API client)
          - \`webchat\` (Iterate webchat client)
          - \`sendEmail(...)\` helper around Resend
          - \`env\` (process env)
          - \`require\` (Node.js require via createRequire)

          \`context\` is also available and contains the same clients/helpers.

          Examples:

          await slack.chat.postMessage({
            channel: "C1234567890",
            text: "Hello",
          });

          await sendEmail({
            to: "person@example.com",
            subject: "Re: Hello",
            text: "Thanks!",
          });

          const output = await replicate.run("black-forest-labs/flux-schnell", {
            input: { prompt: "a photo of a cat" },
          });

          await webchat.postMessage({
            threadId: "thr_123",
            text: "Done.",
          });
        `),
      }),
    )
    .mutation(async ({ input }) => {
      const context = createExecutionContext();
      const slack = createLazyClientProxy(() => context.slack);
      const resend = createLazyClientProxy(() => context.resend);
      const replicate = createLazyClientProxy(() => context.replicate);
      const webchat = createLazyClientProxy(() => context.webchat);
      const require = createRequire(import.meta.url);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
      ) => (
        context: ExecutionContext,
        slack: WebClient,
        resend: Resend,
        replicate: Replicate,
        webchat: WebchatClient,
        sendEmail: ExecutionContext["sendEmail"],
        env: NodeJS.ProcessEnv,
        require: NodeRequire,
      ) => Promise<unknown>;

      const execute = new AsyncFunction(
        "context",
        "slack",
        "resend",
        "replicate",
        "webchat",
        "sendEmail",
        "env",
        "require",
        input.code,
      );

      return await execute(
        context,
        slack,
        resend,
        replicate,
        webchat,
        context.sendEmail,
        context.env,
        require,
      );
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

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        const getDescription = (): string | undefined => {
          if (index > 0) {
            const previousLine = lines[index - 1]?.trim();
            if (previousLine?.startsWith("#") && !previousLine.startsWith("#[")) {
              return previousLine.replace(/^#\s*/, "");
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
