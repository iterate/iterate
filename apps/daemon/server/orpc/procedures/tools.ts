import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { ORPCError } from "@orpc/server";
import { logEmitterStorage, publicProcedure } from "../init.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { wrapCodeWithExportDefault } from "./wrap-code.ts";

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

const clientNames = ["slack", "resend", "replicate", "webchat"] as const;

const require = createRequire(import.meta.url);
const tsgoBin = path.join(
  path.dirname(require.resolve("@typescript/native-preview/package.json")),
  "bin",
  "tsgo.js",
);

const executionContextSourcePath = new URL("./execution-context.ts", import.meta.url).pathname;

/** Generates a `context.ts` re-export pointing back to our real ExecutionContext type. */
function getContextTypeSource(generatedDir: string): string {
  let rel = path.relative(generatedDir, executionContextSourcePath);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return `export type { ExecutionContext } from ${JSON.stringify(rel)};`;
}

/** Lazy-initialized clients available inside execTs/execJs code */
function getLazyClients(): ExecutionContext {
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

// TODO: oRPC doesn't support .meta() — descriptions from .meta({ description }) are dropped for now
export const toolsRouter = {
  readFile: publicProcedure
    .input(
      z.object({
        path: z.string().describe("File path to read. ~ is resolved to the home directory."),
      }),
    )
    .handler(async ({ input }) => {
      const resolvedPath = input.path.startsWith("~")
        ? path.join(homedir(), input.path.slice(1))
        : input.path;
      try {
        const content = await readFile(resolvedPath, "utf-8");
        return { path: resolvedPath, content, exists: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { path: resolvedPath, content: null, exists: false };
        }
        throw err;
      }
    }),

  writeFile: publicProcedure
    .input(
      z.object({
        path: z.string().describe("File path to write. ~ is resolved to the home directory."),
        content: z.string().describe("File content to write"),
        mode: z.number().optional().describe("File permissions mode"),
      }),
    )
    .handler(async ({ input }) => {
      const resolvedPath = input.path.startsWith("~")
        ? path.join(homedir(), input.path.slice(1))
        : input.path;
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, input.content, input.mode ? { mode: input.mode } : undefined);
      return { path: resolvedPath, bytesWritten: Buffer.byteLength(input.content) };
    }),

  execCommand: publicProcedure
    .input(
      z.object({
        command: z
          .array(z.string())
          .meta({ positional: true })
          .describe("Command and arguments. First element is the binary, rest are args."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the command. Default: current working directory"),
        timeout: z.number().optional().describe("Timeout in milliseconds (default: 120000)"),
      }),
    )
    .handler(async ({ input }) => {
      const [command, ...args] = input.command;
      if (!command) throw new Error("command array must have at least one element");
      const result = await exec(command, args, {
        nodeOptions: {
          cwd: input.cwd || process.cwd(),
          timeout: input.timeout ?? 120_000,
        },
      });
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }),

  execTs: publicProcedure
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
          .describe(
            "Filename to generate and execute the code in. Default: generated based on a timestamp.",
          ),
        typecheck: z
          .string()
          .or(z.literal(false))
          .default(`${tsgoBin} --noEmit --ignoreConfig`)
          .describe("Typecheck command. Set to false to skip typechecking."),
        code: z.string().array().meta({ positional: true }).describe(dedent`
          TypeScript code to execute. Can be a full module with \`export default\`, or a shorthand expression/body that will be auto-wrapped.

          Available execution context is from the \`ExecutionContext\` type in \`${path.join(import.meta.dirname, path.relative(import.meta.dirname, executionContextSourcePath))}\`. It is re-exported in a \`context.ts\` file that is generated in the same directory as the code. The interface contains the following properties:
          - \`slack\` — @slack/web-api WebClient (needs SLACK_BOT_TOKEN)
          - \`resend\` — Resend client (needs ITERATE_RESEND_API_KEY)
          - \`replicate\` — Replicate client (needs REPLICATE_API_TOKEN)
          - \`webchat\` — webchat HTTP client (.postMessage, .addReaction, .removeReaction, .getThreadMessages, .listThreads)

          Shorthand: if the code has no \`export default\`, it is auto-wrapped into an async function.
          Context keys used as free variables are auto-injected as destructured params.

          Examples:

          # Single expression
          \`iterate tool exec-ts '"foo bar".split(" ")'\`
          becomes: \`export default async () => "foo bar".split(" ")\`

          # Multi-statement
          \`iterate tool exec-ts 'const words = "foo bar".split(" "); return words.length'\`
          becomes: \`export default async () => { const words = "foo bar".split(" "); return words.length }\`

          # Context auto-injection
          \`iterate tool exec-ts 'slack.chat.postMessage(...)'\`
          becomes: \`export default async ({slack}: import("./context.ts").ExecutionContext) => slack.chat.postMessage(...)\`

          # Full module form still works:
          iterate tool exec-ts 'export default async ({ slack, resend }: import("./context.ts").ExecutionContext) => {
            await slack.chat.postMessage({ channel: "#general", text: "Hello!" });
          }'
        `),
      }),
    )
    .handler(async ({ input }) => {
      const cwd = input.cwd || process.cwd();
      const generatedDir = path.join(cwd, "_generated.ignoreme");
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
          (console as unknown as Record<string, Function>)[level](...args);
          emitter?.dispatchEvent(new CustomEvent("log", { detail: { level, args } }));
        };
      const fakeConsole = Object.fromEntries(
        ["log", "info", "warn", "error", "debug"].map((level) => [level, capture(level)]),
      ) as {} as typeof globalThis.console;

      const globalThisWithShimmedConsoles = globalThis as {} as {
        shimmedConsoles: Record<string, typeof globalThis.console>;
      };
      globalThisWithShimmedConsoles.shimmedConsoles ||= {};
      using _consoleCleanup = {
        [Symbol.dispose]: () => delete globalThisWithShimmedConsoles.shimmedConsoles[filepath],
      };
      const contextTypePath = path.join(generatedDir, "context.ts");
      await writeFile(contextTypePath, getContextTypeSource(generatedDir));
      const wrappedCode = wrapCodeWithExportDefault(input.code.join(" "), {
        contextKeys: [...clientNames],
        contextType: `import("./context.ts").ExecutionContext`,
      });
      const code = [
        `const globalThisWithShimmedConsoles = globalThis as {} as {shimmedConsoles?: Record<string, typeof globalThis.console>};`,
        `const console = globalThisWithShimmedConsoles.shimmedConsoles?.[${JSON.stringify(filepath)}] || globalThis.console;`,
        ``,
        wrappedCode,
      ].join("\n");
      globalThisWithShimmedConsoles.shimmedConsoles[filepath] = fakeConsole;

      await writeFile(filepath, code);
      if (input.typecheck) {
        const [typecheckCommand, ...typecheckArgs] = input.typecheck.trim().split(/\s+/);
        const result = await exec(typecheckCommand, typecheckArgs.concat(filepath), {
          nodeOptions: { cwd },
        });
        if (result.exitCode !== 0) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Typecheck failed:\n${(result.stdout + result.stderr).trim()}`,
          });
        }
      }

      const clients = getLazyClients();

      type ModuleShape = { default: (context: ExecutionContext) => Promise<unknown> };
      const module_: ModuleShape = await tsImport(filepath, { parentURL: import.meta.url });
      return module_.default(clients);
    }),
  execJs: publicProcedure
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
    .handler(async ({ input }) => {
      const require = createRequire(import.meta.url);
      const clients = getLazyClients();
      // Each client name becomes a top-level variable in the executed code.
      // We pass the lazy-getter object as a single arg and destructure inside the
      // function body so getters only fire when user code actually references them.
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      let execute: (...args: unknown[]) => Promise<unknown>;
      try {
        execute = new AsyncFunction(...clientNames, "require", "console", input.code);
      } catch (e) {
        throw new ORPCError("BAD_REQUEST", {
          message: e instanceof Error ? e.message : String(e),
        });
      }
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
    .handler(() => {
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
};
