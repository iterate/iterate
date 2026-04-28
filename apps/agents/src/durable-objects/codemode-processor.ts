import type { GenericEventInput } from "@iterate-com/events-contract";
import { match } from "schematch";
import { z } from "zod";
import {
  AgentInputAddedEvent,
  AgentInputAddedEventInput,
  AgentStatusUpdatedEventInput,
  WebchatResponseAddedEventInput,
} from "./agent-loop-processor-types.ts";
import type { AfterAppendArgs, Append } from "./agent-processor-shared.ts";
import type { IterateAgentProcessorState } from "./agent-processor-types.ts";
import {
  CodemodeBlockAddedEvent,
  CodemodeBlockAddedEventInput,
  CodemodeResultAddedEvent,
  CodemodeResultAddedEventInput,
  ToolProviderConfigUpdatedEvent,
} from "./codemode-processor-types.ts";
import type { Callable } from "~/lib/callable.ts";
import { dispatchCallable } from "~/lib/callable.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

/** Wire shape returned by a `ToolProviderConfig.getTypesCallable`. */
const ProviderTypesResponse = z.object({
  types: z.string(),
});

const WEBCHAT_PROVIDER_TYPES = `declare const webchat: {
  sendMessage(args: { message: string }): Promise<{ ok: true }>;
};`;

const CODEMODE_PRIMER_TEXT = `Just FYI — in this environment, **codemode is how you use tools**. There is no separate direct tool-calling channel: you get work done by writing a JavaScript codemode block in a sandbox with typed namespaces on the global.

The user cannot talk directly to you. You receive trusted event-log renderings as model context, and you respond by calling tools from codemode.

For webchat replies, always call \`webchat.sendMessage({ message })\`. Do not answer with assistant prose. Do not rely on assistant messages being shown to the user: the visible webchat response is the \`webchat-response-added\` event appended by \`webchat.sendMessage\`.

Built-in webchat API:

\`\`\`ts
${WEBCHAT_PROVIDER_TYPES}
\`\`\`

Whenever another tool provider comes online, you will see an extra user message describing that namespace and the TypeScript-style surface you can call from codemode.

Rules for codemode responses:
- When you want to run code, respond with exactly one fenced JavaScript block using \`\`\`js. Do not use prose around it.
- Inside that \`\`\`js block, write a single **async arrow function** that returns the final value you want surfaced back to the chat.
- Use **plain JavaScript** only inside the arrow — no TypeScript type annotations, interfaces, or generics.
- Do **not** define a named function and then call it — write the body directly in the arrow.
- Avoid \`\`\`codemode, \`\`\`javascript, \`\`\`ts, and \`\`\`typescript fences unless the user pasted one already; \`\`\`js is the canonical format.

Canonical response shape:
\`\`\`js
async () => {
  return await webchat.sendMessage({ message: "Hello from the agent." });
}
\`\`\``;

/**
 * Passed to the events `append` path so a burst of `afterAppend` calls before
 * the codemode prompt append has round-tripped back into reduced state still
 * produces at most one `agent-input-added` row.
 */
export const CODEMODE_PRIMER_IDEMPOTENCY_KEY = "iterate-agent:codemode-primer";

async function loadCodemodeRuntime() {
  const [{ DynamicWorkerExecutor, resolveProvider }, { dynamicTools }] = await Promise.all([
    import("@cloudflare/codemode"),
    import("@cloudflare/codemode/dynamic"),
  ]);
  return { DynamicWorkerExecutor, resolveProvider, dynamicTools };
}

type ToolProviderTypesResult =
  | { kind: "ok"; types: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

async function safeGetTypes(args: {
  getTypesCallable: Callable | null | undefined;
  slug: string;
  env: CloudflareEnv;
}): Promise<ToolProviderTypesResult> {
  const { getTypesCallable, slug, env } = args;
  if (getTypesCallable == null) return { kind: "missing" };
  try {
    const { types } = ProviderTypesResponse.parse(
      await dispatchCallable<unknown>({
        callable: getTypesCallable,
        payload: { namespace: slug },
        ctx: { env: env as unknown as Record<string, unknown> },
      }),
    );
    return { kind: "ok", types };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        at: "safeGetTypes.failed",
        slug,
        error: message,
      }),
    );
    return { kind: "error", message };
  }
}

type CodemodeProcessorDeps = {
  loader: WorkerLoader;
  outboundFetch: Fetcher;
  env: CloudflareEnv;
};

async function appendRewrite(args: { append: Append; content: string }): Promise<void> {
  await args.append({
    event: AgentInputAddedEventInput.parse({
      type: "agent-input-added",
      payload: {
        role: "user",
        content: args.content,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    }),
  });
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

No generated API surface was attached to this provider because the \`tool-provider-config-updated\` event did not include \`getTypesCallable\`. Reconfigure the provider with \`getTypesCallable\` before relying on it.`;
  }

  return `${intro}

Failed to load the generated API surface for \`${args.slug}\`: ${args.types.message}`;
}

const CODEMODE_FENCE_RE = /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)\n```\s*$/;

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

export function reduceCodemode(
  event: GenericEventInput,
  state: IterateAgentProcessorState,
): IterateAgentProcessorState | undefined {
  return match(event)
    .case(AgentInputAddedEvent, (e) => {
      if (e.idempotencyKey !== CODEMODE_PRIMER_IDEMPOTENCY_KEY) return undefined;
      return state.hasAppendedCodemodePrompt
        ? state
        : { ...state, hasAppendedCodemodePrompt: true };
    })
    .case(ToolProviderConfigUpdatedEvent, (e) => {
      const { slug, executeCallable, getTypesCallable } = e.payload;
      if (executeCallable === null) {
        const { [slug]: _removed, ...rest } = state.toolProviders;
        return { ...state, toolProviders: rest };
      }
      return {
        ...state,
        toolProviders: {
          ...state.toolProviders,
          [slug]: {
            executeCallable,
            ...(getTypesCallable === undefined || getTypesCallable === null
              ? {}
              : { getTypesCallable }),
          },
        },
      };
    })
    .default(() => undefined);
}

export async function codemodeAfterAppend(
  args: AfterAppendArgs<IterateAgentProcessorState> & { deps: CodemodeProcessorDeps },
): Promise<void> {
  const { append, state, event, deps } = args;

  if (!state.hasAppendedCodemodePrompt) {
    await append({
      event: AgentInputAddedEventInput.parse({
        type: "agent-input-added",
        idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
        payload: {
          role: "user",
          content: CODEMODE_PRIMER_TEXT,
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      }),
    });
  }

  await match(event)
    .case(AgentInputAddedEvent, async (e) => {
      if (e.payload.role !== "assistant") return;
      const script = extractCodemodeScriptFromAssistantResponse(e.payload.content);
      if (script == null) return;
      await append({
        event: CodemodeBlockAddedEventInput.parse({
          type: "codemode-block-added",
          payload: { script },
        }),
      });
    })
    .case(CodemodeBlockAddedEvent, async (e) => {
      const { DynamicWorkerExecutor, resolveProvider, dynamicTools } = await loadCodemodeRuntime();
      const executor = new DynamicWorkerExecutor({
        loader: deps.loader,
        globalOutbound: deps.outboundFetch,
      });

      const dynamicResolved = await Promise.all(
        Object.entries(state.toolProviders).map(async ([slug, config]) => {
          const types = config.getTypesCallable
            ? ProviderTypesResponse.parse(
                await dispatchCallable<unknown>({
                  callable: config.getTypesCallable,
                  payload: { namespace: slug },
                  ctx: { env: deps.env as unknown as Record<string, unknown> },
                }),
              ).types
            : undefined;
          return resolveProvider(
            dynamicTools({
              name: slug,
              types,
              callTool: (name, args) =>
                dispatchCallable({
                  callable: config.executeCallable,
                  payload: { name, args },
                  ctx: { env: deps.env as unknown as Record<string, unknown> },
                }),
            }),
          );
        }),
      );
      const webchatProvider = await resolveProvider(
        dynamicTools({
          name: "webchat",
          types: WEBCHAT_PROVIDER_TYPES,
          callTool: async (name, rawArgs) => {
            if (name !== "sendMessage") {
              throw new Error(`Unknown webchat tool: ${name}`);
            }
            const { message } = parseWebchatSendMessageArgs(rawArgs);
            await append({
              event: WebchatResponseAddedEventInput.parse({
                type: "webchat-response-added",
                payload: { message },
              }),
            });
            return { ok: true };
          },
        }),
      );

      const t0 = Date.now();
      const result = await executor.execute(e.payload.script, [
        { name: "builtin", fns: { answer: async () => 42 } },
        webchatProvider,
        ...dynamicResolved,
      ]);
      const durationMs = Date.now() - t0;

      await append({
        event: CodemodeResultAddedEventInput.parse({
          type: "codemode-result-added",
          payload: {
            result: result.result,
            durationMs,
            ...(result.error == null ? {} : { error: result.error }),
            ...(result.logs == null ? {} : { logs: result.logs }),
          },
        }),
      });
    })
    .case(CodemodeResultAddedEvent, async (e) => {
      if (state.pendingTriggerCount === 0 && args.runtime.inflight() === null) {
        await append({
          event: AgentStatusUpdatedEventInput.parse({
            type: "agent-status-updated",
            payload: { status: "idle", reason: "codemode-result-added" },
          }),
        });
      }
      if (e.offset == null) return;
      await append({
        event: AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: eventBlock({
              offset: e.offset,
              type: e.type,
              fields: {
                success: e.payload.error == null,
                durationMs: e.payload.durationMs,
              },
              valueFields: {
                result: e.payload.result,
                ...(e.payload.error == null ? {} : { error: e.payload.error }),
                ...(e.payload.logs == null || e.payload.logs.length === 0
                  ? {}
                  : { logs: e.payload.logs }),
              },
            }),
            triggerLlmRequest: { behaviour: "dont-trigger-request" },
          },
        }),
      });
    })
    .case(ToolProviderConfigUpdatedEvent, async (e) => {
      const { slug, executeCallable, getTypesCallable } = e.payload;
      if (executeCallable === null) return;
      const typesBlock = await safeGetTypes({
        getTypesCallable,
        slug,
        env: deps.env,
      });
      await appendRewrite({
        append,
        content: toolProviderExplainer({ slug, types: typesBlock }),
      });
    })
    .defaultAsync(() => undefined);
}
