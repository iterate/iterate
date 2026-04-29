import { z } from "zod";
import {
  assertNever,
  buildDerivedIdempotencyKey,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
} from "@iterate-com/shared/stream-processors";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import {
  CODEMODE_PRIMER_IDEMPOTENCY_KEY,
  CodemodeProcessorContract,
  type CodemodeState,
} from "./contract.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { wellBehavedProcessorDefaults } from "../core/well-behaved-processor-defaults.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const ProviderTypesResponse = z.object({
  types: z.string(),
});

const WEBCHAT_PROVIDER_TYPES = `declare const webchat: {
  sendMessage(args: { message: string }): Promise<{ ok: true }>;
};`;

const CODEMODE_PRIMER_TEXT = `Just FYI: codemode is how you use tools in this stream.

When you want to run a tool, respond with exactly one fenced JavaScript block using \`\`\`js. The body should be a single async arrow function. For webchat replies, call \`webchat.sendMessage({ message })\`; do not rely on assistant prose being shown to the user.

Built-in webchat API:

\`\`\`ts
${WEBCHAT_PROVIDER_TYPES}
\`\`\``;

const CODEMODE_FENCE_RE = /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)\n```\s*$/;

type CodemodeStreamApi = ProcessorStreamApi<typeof CodemodeProcessorContract>;
type CodemodeConsumedEvent = ConsumedEvent<typeof CodemodeProcessorContract>;

export type CodemodeProcessorDeps = {
  loader: WorkerLoader;
  outboundFetch: Fetcher;
  env: CloudflareEnv;
};

type ToolProviderTypesResult =
  | { kind: "ok"; types: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function createCodemodeProcessor(deps: CodemodeProcessorDeps) {
  return implementProcessor(CodemodeProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },

    async afterAppend({ event, state, streamApi }) {
      await wellBehavedProcessorDefaults.afterAppend({
        contract: CodemodeProcessorContract,
        state,
        streamApi,
      });

      await appendCodemodePrimerIfNeeded({ state, streamApi });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/agent/system-prompt-updated":
        case "events.iterate.com/agent/webchat-message-received":
        case "events.iterate.com/agent/webchat-response-added":
        case "events.iterate.com/agent/llm-config-updated":
        case "events.iterate.com/agent/llm-request-scheduled":
        case "events.iterate.com/agent/llm-request-started":
        case "events.iterate.com/agent/llm-request-completed":
        case "events.iterate.com/agent/llm-request-failed":
        case "events.iterate.com/agent/llm-request-cancelled":
        case "events.iterate.com/agent/llm-request-queued":
        case "events.iterate.com/agent/status-updated":
          return;
        case "events.iterate.com/codemode/block-added":
          await executeCodemodeBlock({
            deps,
            event,
            state,
            streamApi,
          });
          return;
        case "events.iterate.com/agent/input-added": {
          if (event.payload.role !== "assistant") return;
          const script = extractCodemodeScriptFromAssistantResponse(event.payload.content);
          if (script == null) return;

          await streamApi.append({
            event: {
              type: "events.iterate.com/codemode/block-added",
              idempotencyKey: buildDerivedIdempotencyKey({
                slug: CodemodeProcessorContract.slug,
                purpose: "assistant-input-to-block",
                event,
              }),
              payload: { script },
            },
          });
          return;
        }
        case "events.iterate.com/codemode/result-added":
          await appendCodemodeResultAsAgentInput({ event, streamApi });
          await appendIdleStatusIfAgentHasNoQueuedTriggers({ event, state, streamApi });
          return;
        case "events.iterate.com/codemode/tool-provider-config-updated": {
          const { executeCallable, getTypesCallable, slug } = event.payload;
          if (executeCallable === null) return;
          const types = await safeGetTypes({
            env: deps.env,
            getTypesCallable,
            slug,
          });
          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildDerivedIdempotencyKey({
                slug: CodemodeProcessorContract.slug,
                purpose: "tool-provider-explainer",
                event,
              }),
              payload: {
                role: "user",
                content: toolProviderExplainer({ slug, types }),
                triggerLlmRequest: { behaviour: "dont-trigger-request" },
              },
            },
          });
          return;
        }
        default:
          return assertNever(event);
      }
    },
  });
}

export function extractCodemodeScriptFromAssistantResponse(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("async () => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = CODEMODE_FENCE_RE.exec(trimmed);
  return fenced?.[1].trim() || null;
}

export function parseWebchatSendMessageArgs(rawArgs: unknown): { message: string } {
  const firstArg = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs;
  return z.object({ message: z.string().min(1) }).parse(firstArg);
}

async function appendCodemodePrimerIfNeeded(args: {
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  if (args.state.hasAppendedCodemodePrompt) return;

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
      payload: {
        role: "user",
        content: CODEMODE_PRIMER_TEXT,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

async function executeCodemodeBlock(args: {
  deps: CodemodeProcessorDeps;
  event: Extract<CodemodeConsumedEvent, { type: "events.iterate.com/codemode/block-added" }>;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  const [{ DynamicWorkerExecutor, resolveProvider }, { dynamicTools }] = await Promise.all([
    import("@cloudflare/codemode"),
    import("@cloudflare/codemode/dynamic"),
  ]);
  const executor = new DynamicWorkerExecutor({
    loader: args.deps.loader,
    globalOutbound: args.deps.outboundFetch,
  });

  const dynamicResolved = await Promise.all(
    Object.entries(args.state.toolProviders).map(async ([slug, config]) => {
      const typesResult = await safeGetTypes({
        getTypesCallable: config.getTypesCallable,
        slug,
        env: args.deps.env,
      });
      return resolveProvider(
        dynamicTools({
          name: slug,
          types: typesResult.kind === "ok" ? typesResult.types : undefined,
          callTool: (name, toolArgs) =>
            dispatchCallable({
              callable: config.executeCallable,
              payload: { name, args: toolArgs },
              ctx: { env: args.deps.env as unknown as Record<string, unknown> },
            }),
        }),
      );
    }),
  );

  let webchatMessageSeq = 0;
  const webchatProvider = await resolveProvider(
    dynamicTools({
      name: "webchat",
      types: WEBCHAT_PROVIDER_TYPES,
      callTool: async (name, rawArgs) => {
        if (name !== "sendMessage") {
          throw new Error(`Unknown webchat tool: ${name}`);
        }
        webchatMessageSeq += 1;
        const { message } = parseWebchatSendMessageArgs(rawArgs);
        await args.streamApi.append({
          event: {
            type: "events.iterate.com/agent/webchat-response-added",
            idempotencyKey: buildDerivedIdempotencyKey({
              slug: CodemodeProcessorContract.slug,
              purpose: `webchat-send-message:${webchatMessageSeq}`,
              event: args.event,
            }),
            payload: { message },
          },
        });
        return { ok: true };
      },
    }),
  );

  const t0 = Date.now();
  const result = await executor.execute(args.event.payload.script, [
    webchatProvider,
    ...dynamicResolved,
  ]);

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/result-added",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "block-to-result",
        event: args.event,
      }),
      payload: {
        result: result.result,
        durationMs: Date.now() - t0,
        ...(result.error == null ? {} : { error: result.error }),
        ...(result.logs == null ? {} : { logs: result.logs }),
      },
    },
  });
}

async function appendCodemodeResultAsAgentInput(args: {
  event: Extract<CodemodeConsumedEvent, { type: "events.iterate.com/codemode/result-added" }>;
  streamApi: CodemodeStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "result-to-agent-input",
        event: args.event,
      }),
      payload: {
        role: "user",
        content: eventBlock({
          offset: args.event.offset,
          type: args.event.type,
          fields: {
            success: args.event.payload.error == null,
            durationMs: args.event.payload.durationMs,
          },
          valueFields: {
            result: args.event.payload.result,
            ...(args.event.payload.error == null ? {} : { error: args.event.payload.error }),
            ...(args.event.payload.logs == null || args.event.payload.logs.length === 0
              ? {}
              : { logs: args.event.payload.logs }),
          },
        }),
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

/**
 * Example of "peeking" another processor without coupling to its instance.
 *
 * Codemode does not get to read an in-memory AgentProcessor object. Its
 * contract reducer keeps `state.processorDeps.agent` current by running the
 * frontend-safe agent reducer, and the hook makes a local decision from that
 * embedded dependency snapshot.
 */
async function appendIdleStatusIfAgentHasNoQueuedTriggers(args: {
  event: Extract<CodemodeConsumedEvent, { type: "events.iterate.com/codemode/result-added" }>;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  if (args.state.processorDeps.agent.pendingTriggerCount > 0) return;

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/status-updated",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "codemode-result-to-idle-status",
        event: args.event,
      }),
      payload: {
        status: "idle",
        reason: "codemode-result-added",
      },
    },
  });
}

async function safeGetTypes(args: {
  getTypesCallable: Callable | null | undefined;
  slug: string;
  env: CloudflareEnv;
}): Promise<ToolProviderTypesResult> {
  if (args.getTypesCallable == null) return { kind: "missing" };

  try {
    const { types } = ProviderTypesResponse.parse(
      await dispatchCallable({
        callable: args.getTypesCallable,
        payload: { namespace: args.slug },
        ctx: { env: args.env as unknown as Record<string, unknown> },
      }),
    );
    return { kind: "ok", types };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        at: "codemode.safeGetTypes.failed",
        slug: args.slug,
        error: message,
      }),
    );
    return { kind: "error", message };
  }
}

function toolProviderExplainer(args: { slug: string; types: ToolProviderTypesResult }) {
  const intro = `Tool provider \`${args.slug}\` is now available. Use it only from a codemode response: emit one \`\`\`js block whose body is a single async arrow function, then call tools as \`${args.slug}.<tool>(...)\`.`;

  if (args.types.kind === "ok") {
    return `${intro}

Complete generated API surface for \`${args.slug}\`:

\`\`\`ts
${args.types.types.trim()}
\`\`\``;
  }

  if (args.types.kind === "missing") {
    return `${intro}

No generated API surface was attached to this provider because the event did not include \`getTypesCallable\`.`;
  }

  return `${intro}

Failed to load the generated API surface for \`${args.slug}\`: ${args.types.message}`;
}

function eventBlock(args: {
  offset: number;
  type: string;
  fields?: Record<string, string | number | boolean>;
  valueFields?: Record<string, unknown>;
}): string {
  const yamlLines = [
    "event:",
    `  offset: ${args.offset}`,
    `  type: ${yamlScalar(args.type)}`,
    ...Object.entries(args.fields ?? {}).map(([key, value]) => `  ${key}: ${yamlScalar(value)}`),
    ...Object.entries(args.valueFields ?? {}).flatMap(([key, value]) =>
      yamlBlockScalar(key, stringifyUnknown(value), 2),
    ),
  ];
  return ["```yaml", ...yamlLines, "```"].join("\n");
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(key: string, value: string, indent: number): string[] {
  const prefix = " ".repeat(indent);
  return [`${prefix}${key}: |-`, ...value.split("\n").map((line) => `${prefix}  ${line}`)];
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
