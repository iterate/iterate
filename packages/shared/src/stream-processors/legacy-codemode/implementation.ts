import { z } from "zod";
import {
  assertNever,
  buildProcessorIdempotencyKey,
  implementProcessor,
  type ConsumedEvent,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { dispatchCallable } from "../../callable/runtime.ts";
import type { Callable } from "../../callable/types.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import {
  CODEMODE_AUTOMATIC_CONTINUATION_LIMIT,
  CODEMODE_PRIMER_TEXT,
  CODEMODE_PRIMER_IDEMPOTENCY_KEY,
  CODEMODE_WEBCHAT_PROVIDER_TYPES,
  CodemodeProcessorContract,
  codemodeResultNeedsAgentTurn,
  type CodemodeState,
} from "./contract.ts";
import type { CodemodeCodeExecutor } from "./code-executor.ts";

const ProviderTypesResponse = z.object({
  types: z.string(),
});

const CODEMODE_FENCE_RE = /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)\n```\s*$/;

type CodemodeStreamApi = ProcessorStreamApi<typeof CodemodeProcessorContract>;
type CodemodeConsumedEvent = ConsumedEvent<typeof CodemodeProcessorContract>;

export type CodemodeProcessorDeps = {
  codeExecutor: CodemodeCodeExecutor;
  env: Record<string, unknown>;
};

type ToolProviderTypesResult =
  | { kind: "ok"; types: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function createCodemodeProcessor(deps: CodemodeProcessorDeps) {
  return implementProcessor(CodemodeProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },

    async afterAppend({ event, previousState, state, streamApi, signal }) {
      // Standard processor behavior is just another side effect Codemode wants
      // to run before its event-specific side effects.
      await standardProcessorBehavior.afterAppend({
        contract: CodemodeProcessorContract,
        state,
        streamApi,
      });

      // Codemode owns this one-time primer. The reducer observes the eventual
      // appended event by idempotency key and records that the primer landed.
      await appendCodemodePrimerIfNeeded({ state, streamApi });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
        case "events.iterate.com/agent/system-prompt-updated":
        case "events.iterate.com/agent/llm-config-updated":
        case "events.iterate.com/agent/llm-request-scheduled":
        case "events.iterate.com/agent/llm-request-requested":
        case "events.iterate.com/agent/llm-request-completed":
        case "events.iterate.com/agent/llm-request-cancelled":
        case "events.iterate.com/agent/llm-request-queued":
        case "events.iterate.com/agent/status-updated":
        case "events.iterate.com/agent/input-added":
        case "events.iterate.com/codemode/tool-provider-registered":
          return;
        case "events.iterate.com/agent/output-added": {
          const script = extractCodemodeScriptFromAssistantResponse(event.payload.content);
          if (script == null) return;

          await streamApi.append({
            event: {
              type: "events.iterate.com/codemode/block-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: CodemodeProcessorContract,
                key: "assistant-output-to-block",
                sourceEvent: event,
              }),
              payload: { script },
            },
          });
          return;
        }
        case "events.iterate.com/codemode/block-added":
          await executeCodemodeBlock({
            deps,
            event,
            signal,
            state,
            streamApi,
          });
          return;
        case "events.iterate.com/codemode/result-added":
          await appendCodemodeResultFollowUp({ event, previousState, streamApi });
          await appendIdleStatusIfAgentIsQuiescent({ event, state, streamApi });
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
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: CodemodeProcessorContract,
                key: "tool-provider-explainer",
                sourceEvent: event,
              }),
              payload: {
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
        content: CODEMODE_PRIMER_TEXT,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

async function executeCodemodeBlock(args: {
  deps: CodemodeProcessorDeps;
  event: Extract<CodemodeConsumedEvent, { type: "events.iterate.com/codemode/block-added" }>;
  signal: AbortSignal;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  const toolProviders = await Promise.all(
    Object.entries(args.state.toolProviders).map(async ([slug, config]) => {
      const typesResult = await safeGetTypes({
        getTypesCallable: config.getTypesCallable,
        slug,
        env: args.deps.env,
      });
      return {
        slug,
        executeCallable: config.executeCallable,
        ...(typesResult.kind === "ok" ? { types: typesResult.types } : {}),
      };
    }),
  );

  let webchatMessageSeq = 0;
  const t0 = Date.now();
  const result = await args.deps.codeExecutor({
    script: args.event.payload.script,
    env: args.deps.env,
    signal: args.signal,
    toolProviders,
    webchat: {
      types: CODEMODE_WEBCHAT_PROVIDER_TYPES,
      async callTool({ name, rawArgs }) {
        if (name !== "sendMessage") {
          throw new Error(`Unknown webchat tool: ${name}`);
        }
        webchatMessageSeq += 1;
        const { message } = parseWebchatSendMessageArgs(rawArgs);
        await args.streamApi.append({
          event: {
            type: "events.iterate.com/agent-chat/assistant-response-added",
            idempotencyKey: buildProcessorIdempotencyKey({
              processor: CodemodeProcessorContract,
              key: `webchat-send-message/${webchatMessageSeq}`,
              sourceEvent: args.event,
            }),
            payload: { channel: "web", message },
          },
        });
        return undefined;
      },
    },
  });

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/codemode/result-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CodemodeProcessorContract,
        key: "block-to-result",
        sourceEvent: args.event,
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
  key: string;
  intro?: string;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CodemodeProcessorContract,
        key: args.key,
        sourceEvent: args.event,
      }),
      payload: {
        content: [
          args.intro,
          eventBlock({
            offset: args.event.offset,
            type: args.event.type,
            fields: {
              success: args.event.payload.error == null,
              durationMs: args.event.payload.durationMs,
            },
            valueFields: {
              ...(args.event.payload.result === undefined
                ? {}
                : { result: args.event.payload.result }),
              ...(args.event.payload.error == null ? {} : { error: args.event.payload.error }),
              ...(args.event.payload.logs == null || args.event.payload.logs.length === 0
                ? {}
                : { logs: args.event.payload.logs }),
            },
          }),
        ]
          .filter(Boolean)
          .join("\n\n"),
        triggerLlmRequest: { behaviour: "after-current-request" },
      },
    },
  });
}

async function appendCodemodeResultFollowUp(args: {
  event: Extract<CodemodeConsumedEvent, { type: "events.iterate.com/codemode/result-added" }>;
  previousState: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  if (!codemodeResultNeedsAgentTurn(args.event.payload)) return;
  // The reducer has already spent budget in `state`; previousState is the
  // durable budget that was available before this result landed.
  if (args.previousState.automaticContinuationsUsed < CODEMODE_AUTOMATIC_CONTINUATION_LIMIT) {
    await appendCodemodeResultAsAgentInput({
      event: args.event,
      streamApi: args.streamApi,
      key: "result-to-agent-input",
    });
    return;
  }
  if (args.previousState.finalWrapUpRequested) return;
  await appendCodemodeResultAsAgentInput({
    event: args.event,
    streamApi: args.streamApi,
    key: "result-to-final-wrap-up",
    intro: `Automatic codemode continuation limit reached after ${CODEMODE_AUTOMATIC_CONTINUATION_LIMIT} turns. Use this final result to summarize current state and ask the user whether to continue.`,
  });
}

/**
 * Example of "peeking" another processor without coupling to its instance.
 *
 * Codemode does not get to read an in-memory AgentProcessor object. Its
 * contract reducer keeps `state.agentProcessor` current by running the
 * frontend-safe Agent reducer, and the hook makes a local decision from that
 * embedded state.
 */
async function appendIdleStatusIfAgentIsQuiescent(args: {
  event: Extract<CodemodeConsumedEvent, { type: "events.iterate.com/codemode/result-added" }>;
  state: CodemodeState;
  streamApi: CodemodeStreamApi;
}) {
  if (args.state.agentProcessor.currentRequest != null) return;
  if (args.state.agentProcessor.pendingTriggerCount > 0) return;

  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/status-updated",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: CodemodeProcessorContract,
        key: "codemode-result-to-idle-status",
        sourceEvent: args.event,
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
  env: Record<string, unknown>;
}): Promise<ToolProviderTypesResult> {
  if (args.getTypesCallable == null) return { kind: "missing" };

  try {
    const { types } = ProviderTypesResponse.parse(
      await dispatchCallable({
        callable: args.getTypesCallable,
        payload: { namespace: args.slug },
        ctx: { env: args.env },
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
