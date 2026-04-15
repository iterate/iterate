import {
  normalizeCode,
  resolveProvider,
  type ExecuteResult,
  type Executor,
  type ResolvedProvider,
} from "@cloudflare/codemode";
import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import z from "zod";
import { AgentInputEvent } from "./agent.ts";

const CodemodeBlockAddedEvent = z.object({
  type: z.literal("codemode-block-added"),
  payload: z.object({
    code: z.string(),
  }),
});

const AppendToolInput = z.object({
  event: z.object({ type: z.string() }).passthrough(),
});

const SendMessageToolInput = z.object({
  message: z.string(),
});

interface AsyncFunctionConstructor {
  new (...args: string[]): (...args: unknown[]) => Promise<unknown>;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as AsyncFunctionConstructor;

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createNamespace(provider: ResolvedProvider) {
  return new Proxy<Record<PropertyKey, unknown>>(
    {},
    {
      get: (_target, toolName) => {
        const fn = provider.fns[String(toolName)];
        if (!fn) {
          throw new Error(`Tool "${provider.name}.${String(toolName)}" not found`);
        }

        if (provider.positionalArgs) {
          return (...args: unknown[]) => fn(...args);
        }

        return (args: unknown) => fn(args);
      },
    },
  );
}

class JavaScriptExecutor implements Executor {
  async execute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<ExecuteResult> {
    const providers = Array.isArray(providersOrFns)
      ? providersOrFns
      : [{ name: "codemode", fns: providersOrFns }];
    const logs: string[] = [];
    const namespaces = Object.fromEntries(
      providers.map((provider) => [provider.name, createNamespace(provider)]),
    );
    const sandboxConsole = {
      log: (...args: unknown[]) => logs.push(args.map(stringifyUnknown).join(" ")),
      warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(stringifyUnknown).join(" ")}`),
      error: (...args: unknown[]) => logs.push(`[error] ${args.map(stringifyUnknown).join(" ")}`),
    };

    try {
      const run = new AsyncFunction(
        ...Object.keys(namespaces),
        "console",
        `return await (${normalizeCode(code)})();`,
      );
      const result = await run(...Object.values(namespaces), sandboxConsole);
      return { result, logs };
    } catch (error) {
      return {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
        logs,
      };
    }
  }
}

export const processor = defineProcessor(() => {
  const executor = new JavaScriptExecutor();

  return {
    slug: "codemode",
    afterAppend: async ({ append, event, logger }) => {
      const agentInput = AgentInputEvent.safeParse(event);
      if (agentInput.success) {
        if (agentInput.data.payload.role !== "assistant") return;

        const code = agentInput.data.payload.content.match(
          /```(?:js|javascript)\n(.*?)\n```/s,
        )?.[1];
        if (!code) return;

        await append({
          event: {
            type: "codemode-block-added",
            payload: { code },
          },
        });
        return;
      }

      const codemodeBlock = CodemodeBlockAddedEvent.safeParse(event);
      if (!codemodeBlock.success) {
        logger.info("Ignoring event", event);
        return;
      }

      const appendEvent = async (nextEvent: { type: string; [key: string]: unknown }) => {
        await append({ event: nextEvent });
        return nextEvent;
      };

      const codemode = resolveProvider({
        tools: {
          append: {
            description: "Append an event to the current stream.",
            execute: async (args: unknown) => {
              const { event } = AppendToolInput.parse(args);
              return appendEvent(event);
            },
          },
          sendMessage: {
            description: "Send a message to the user.",
            execute: async (args: unknown) => {
              const { message } = SendMessageToolInput.parse(args);
              return appendEvent({
                type: "message-added",
                payload: { message },
              });
            },
          },
        },
      });

      const result = await executor.execute(codemodeBlock.data.payload.code, [codemode]);
      await append({
        event: {
          type: "codemode-result-added",
          payload: {
            result: stringifyUnknown(result.result),
            error: result.error ?? null,
            logs: result.logs ?? [],
          },
        },
      });
    },
  };
});

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/video",
    includeChildren: true,
    processor,
  }).run();
}
