import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import { exec } from "tinyexec";
import { LogLevel, WebClient } from "@slack/web-api";
import dedent from "dedent";
import Replicate from "replicate";
import { Resend } from "resend";
import { z } from "zod/v4";
import { tsImport } from "tsx/esm/api";
import { createTRPCRouter, logEmitterStorage, publicProcedure } from "../init.ts";

function getWebchatClient() {
  const daemonPort = process.env.PORT || "3001";
  const baseUrl = `http://localhost:${daemonPort}/api/integrations/webchat`;

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
    postMessage: (params: { threadId: string; text?: string; attachments?: unknown[] }) =>
      post("/postMessage", params),
    addReaction: (params: { threadId: string; messageId: string; reaction: string }) =>
      post("/addReaction", params),
    removeReaction: (params: { threadId: string; messageId: string; reaction: string }) =>
      post("/removeReaction", params),
    getThreadMessages: (params: { threadId: string }) =>
      get(`/threads/${encodeURIComponent(params.threadId)}/messages`),
    listThreads: () => get("/threads"),
  };
}

/** Lazy-initialized clients available inside execJs code */
function getLazyClients() {
  let _slack: WebClient | undefined;
  let _resend: Resend | undefined;
  let _replicate: Replicate | undefined;
  let _webchat: ReturnType<typeof getWebchatClient> | undefined;

  return {
    get slack() {
      if (!_slack) {
        const token = process.env.SLACK_BOT_TOKEN;
        if (!token) throw new Error("SLACK_BOT_TOKEN environment variable is required");
        _slack = new WebClient(token, { logLevel: LogLevel.DEBUG });
      }
      return _slack;
    },
    get resend() {
      if (!_resend) {
        const apiKey = process.env.ITERATE_RESEND_API_KEY;
        if (!apiKey) throw new Error("ITERATE_RESEND_API_KEY environment variable is required");
        _resend = new Resend(apiKey);
      }
      return _resend;
    },
    get replicate() {
      if (!_replicate) {
        const token = process.env.REPLICATE_API_TOKEN;
        if (!token) throw new Error("REPLICATE_API_TOKEN environment variable is required");
        _replicate = new Replicate({ auth: token });
      }
      return _replicate;
    },
    get webchat() {
      if (!_webchat) {
        _webchat = getWebchatClient();
      }
      return _webchat;
    },
  };
}

export const toolsRouter = createTRPCRouter({
  execTs: publicProcedure
    .meta({ description: "Execute TypeScript with access to integration clients" })
    .input(
      z.object({
        cwd: z
          .string()
          .optional()
          .describe(
            "Current working directory to generate and execute the code in. Default: current working directory",
          ),
        filename: z
          .string()
          .optional()
          .describe("Filename to generate and execute the code in. Default: `${Date.now()}.ts"),
        typecheck: z
          .string()
          .or(z.literal(false))
          .default("npx tsc --noEmit")
          .describe("Typecheck command. Set to false to skip typechecking."),
        code: z.string().meta({ positional: true }).describe(dedent`
          TypeScript code to execute. This should be in the form of a full module with a default export function which will be called with an execution context object:

          - \`slack\` — @slack/web-api WebClient (needs SLACK_BOT_TOKEN)
          - \`resend\` — Resend client (needs ITERATE_RESEND_API_KEY)
          - \`replicate\` — Replicate client (needs REPLICATE_API_TOKEN)
          - \`webchat\` — webchat HTTP client (.postMessage, .addReaction, .removeReaction, .getThreadMessages, .listThreads)

          Example module invocation:

          iterate tool exec-ts 'export default async () => 123' # prints 123
          iterate tool exec-ts 'export default async () => console.log(123)' # console.log is piped to the CLI caller so this prints 123 as well
          iterate tool exec-ts 'export default async ({ slack, resend }) => {
            await slack.chat.postMessage({ channel: "#general", text: "Hello!" });
            await resend.emails.send({
              from: "Agent <agent@example.com>",
              to: ["user@example.com"],
              subject: "Hello",
              text: "Hi there",
            });
          }' # clients injected into the context are lazy-initialized, so missing env vars won't cause an error unless used
        `),
      }),
    )
    .mutation(async ({ input }) => {
      const cwd = input.cwd || process.cwd();
      const generatedDir = path.join(cwd, "_generated");
      const filename = input.filename || `${new Date().toISOString().replaceAll(":", ".")}.ts`;
      const filepath = path.join(generatedDir, filename);
      await mkdir(path.dirname(filepath), { recursive: true });

      // Build a console that emits to an EventTarget so streaming callers can
      // pick up logs in real-time, while also forwarding to the real console.
      const emitter = logEmitterStorage.getStore();
      const capture =
        (level: string) =>
        (...args: unknown[]) => {
          // Always forward to real console so daemon logs still work
          (console as unknown as Record<string, Function>)[level]?.(...args);
          emitter?.dispatchEvent(new CustomEvent("log", { detail: { level, args } }));
        };
      const fakeConsole = {
        log: capture("log"),
        info: capture("info"),
        warn: capture("warn"),
        error: capture("error"),
        debug: capture("debug"),
      };

      const globalThisWithShimmedConsoles = globalThis as {} as {
        shimmedConsoles: Record<string, typeof globalThis.console>;
      };
      globalThisWithShimmedConsoles.shimmedConsoles ||= {};
      using _consoleCleanup = {
        [Symbol.dispose]: () => delete globalThisWithShimmedConsoles.shimmedConsoles[filepath],
      };
      const code = [
        `const globalThisWithShimmedConsoles = globalThis as {} as {shimmedConsoles?: Record<string, typeof globalThis.console>};`,
        `const console = globalThisWithShimmedConsoles.shimmedConsoles?.[${JSON.stringify(filepath)}] || globalThis.console;`,
        ``,
        input.code,
      ].join("\n");
      globalThisWithShimmedConsoles.shimmedConsoles[filepath] =
        fakeConsole as typeof globalThis.console;

      await writeFile(filepath, code);
      if (input.typecheck) {
        const [typecheckCommand, ...typecheckArgs] = input.typecheck.trim().split(/\s+/);
        const result = await exec(typecheckCommand, typecheckArgs.concat(filepath), {
          nodeOptions: { cwd },
        });
        if (result.exitCode !== 0) {
          throw new Error(`Typecheck failed: ${result.stdout + result.stderr}`);
        }
      }

      const clients = getLazyClients();

      type ModuleShape = { default: (context: typeof clients) => Promise<unknown> };
      const module_: ModuleShape = await tsImport(filepath, { parentURL: import.meta.url });
      return module_.default(clients);
    }),
  execJs: publicProcedure
    .meta({ description: "Execute JavaScript with access to integration clients" })
    .input(
      z.object({
        code: z.string().meta({ positional: true }).describe(dedent`
          JavaScript code to execute. The following clients are available as lazy globals
          (only initialized when first accessed, so missing env vars won't error unless used):

          - \`slack\` — @slack/web-api WebClient (needs SLACK_BOT_TOKEN)
          - \`resend\` — Resend client (needs ITERATE_RESEND_API_KEY)
          - \`replicate\` — Replicate client (needs REPLICATE_API_TOKEN)
          - \`webchat\` — webchat HTTP client (.postMessage, .addReaction, .removeReaction, .getThreadMessages, .listThreads)
          - \`require\` — Node.js require function

          Examples:

          // Send a Slack message
          await slack.chat.postMessage({ channel: "#general", text: "Hello!" });

          // Send an email
          await resend.emails.send({
            from: "Agent <agent@example.com>",
            to: ["user@example.com"],
            subject: "Hello",
            text: "Hi there",
          });

          // Run an AI model
          const output = await replicate.run("black-forest-labs/flux-schnell", {
            input: { prompt: "a photo of a cat" },
          });

          // Post a webchat message
          await webchat.postMessage({ threadId: "THREAD_ID", text: "Hello!" });
        `),
      }),
    )
    .mutation(async ({ input }) => {
      const require = createRequire(import.meta.url);
      const clients = getLazyClients();
      // Each client name becomes a top-level variable in the executed code.
      // We pass the lazy-getter object as a single arg and destructure inside the
      // function body so getters only fire when user code actually references them.
      const clientNames = ["slack", "resend", "replicate", "webchat"] as const;
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const execute = new AsyncFunction(...clientNames, "require", "console", input.code);
      // Build lazy proxies: each is a thin wrapper that defers to the real client
      // only on first property access, so missing env vars don't blow up if unused.
      const lazyArgs = clientNames.map(
        (name) =>
          new Proxy(Object.create(null), {
            get(_, prop) {
              return Reflect.get(clients[name], prop);
            },
          }),
      );
      // Build a console that emits to an EventTarget so streaming callers can
      // pick up logs in real-time, while also forwarding to the real console.
      const emitter = logEmitterStorage.getStore();
      const capture =
        (level: string) =>
        (...args: unknown[]) => {
          // Always forward to real console so daemon logs still work
          (console as unknown as Record<string, Function>)[level]?.(...args);
          emitter?.dispatchEvent(new CustomEvent("log", { detail: { level, args } }));
        };
      const fakeConsole = {
        log: capture("log"),
        info: capture("info"),
        warn: capture("warn"),
        error: capture("error"),
        debug: capture("debug"),
      };
      const result = await execute(...lazyArgs, require, fakeConsole);
      return result;
    }),

  printenv: publicProcedure
    .meta({ description: "List environment variables from ~/.iterate/.env" })
    .input(z.object({}).optional())
    .query(() => {
      const envFilePath = path.join(homedir(), ".iterate/.env");
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
