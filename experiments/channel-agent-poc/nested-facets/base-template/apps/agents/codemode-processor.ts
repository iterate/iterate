import type { AgentEvent, AfterAppendArgs, Append } from "./agent-processor-shared.ts";
import type { IterateAgentProcessorState } from "./agent-processor-types.ts";

const CODEMODE_PRIMER_TEXT = `Just FYI - in this environment, **codemode is how you use tools**. There is no separate direct tool-calling channel: you get work done by writing a JavaScript codemode block in a sandbox with typed namespaces on the global.

The user cannot talk directly to you. You receive trusted event-log renderings as model context, and you respond by calling tools from codemode.

Whenever another tool provider comes online, you will see an extra user message describing that namespace and the TypeScript-style surface you can call from codemode.

Rules for codemode responses:
- When you want to run code, respond with exactly one fenced JavaScript block using \`\`\`js. Do not use prose around it.
- Inside that \`\`\`js block, write the body of the program directly. The runtime supplies the function wrapper.
- Do **not** write \`async () => { ... }\`, \`async function\`, or any other wrapper. Start with statements like \`const x = ...\` and use top-level \`return\`.
- Use **plain JavaScript** only - no TypeScript type annotations, interfaces, or generics.
- Use \`await\` and \`return\` directly at the top level of the block when needed.
- Return the final tool promise or result. Do not end codemode with only an awaited side effect.
- Use only tool provider globals that have been announced in this stream. Do not call \`webchat\` unless a \`webchat\` provider is explicitly announced.
- There is no implicit \`event\`, \`message\`, \`ctx\`, \`input\`, or \`payload\` variable in codemode. Copy exact IDs and values from the YAML context into local constants before calling tools.
- When performing more than one independent tool side effect in the same response, run them concurrently with \`Promise.all([...])\` and return the combined result. Do not serialize independent tool calls with multiple \`await\` statements.
- Avoid \`\`\`codemode, \`\`\`javascript, \`\`\`ts, and \`\`\`typescript fences unless the user pasted one already; \`\`\`js is the canonical format.

Canonical response shape:
\`\`\`js
return await announced_provider.someTool({ message: "Hello from the agent." });
\`\`\``;

export const CODEMODE_PRIMER_IDEMPOTENCY_KEY = "iterate-agent:codemode-primer";
export const CODEMODE_PROVIDER_EXPLAINER_IDEMPOTENCY_KEY =
  "iterate-agent:codemode-provider-explainer";

type CodemodeProcessorDeps = {
  executeScript(script: string): Promise<{ result?: unknown; error?: string; logs?: string[] }>;
  describeProviders(): Promise<Array<{ name: string; tools: string[]; types?: string }>>;
};

async function appendRewrite(args: {
  append: Append;
  content: string;
  idempotencyKey?: string;
}): Promise<void> {
  await args.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      ...(args.idempotencyKey == null ? {} : { idempotencyKey: args.idempotencyKey }),
      payload: {
        role: "user",
        content: args.content,
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

function toolProviderExplainer(
  providers: Array<{ name: string; tools: string[]; types?: string }>,
) {
  const types = providers
    .map((provider) => provider.types?.trim() || fallbackProviderTypes(provider))
    .filter((block) => block.length > 0)
    .join("\n\n");

  return `Tool providers are available. Use these namespaces only from codemode responses: emit one \`\`\`js block containing the program body directly, then call the typed globals below.

Complete generated API surface:

\`\`\`ts
${types}
\`\`\``;
}

function fallbackProviderTypes(provider: { name: string; tools: string[] }): string {
  const methods = provider.tools
    .map((tool) => `  ${tool}(args?: unknown): Promise<unknown>;`)
    .join("\n");
  return `declare const ${provider.name}: {\n${methods}\n};`;
}

function toolProviderConfigMessage(payload: Record<string, any>): string {
  if (typeof payload.content === "string" && payload.content.trim()) return payload.content;
  const slug = String(payload.slug ?? payload.namespace ?? "unknown");
  const kind = String(payload.kind ?? "dynamic");
  const types = typeof payload.types === "string" ? payload.types.trim() : "";
  const endpoint = typeof payload.endpoint === "string" ? `\nEndpoint: ${payload.endpoint}` : "";
  const specUrl = typeof payload.specUrl === "string" ? `\nOpenAPI spec: ${payload.specUrl}` : "";
  return `Tool provider \`${slug}\` is configured (${kind}). Use it only from codemode responses.${endpoint}${specUrl}${
    types ? `\n\nGenerated API surface:\n\n\`\`\`ts\n${types}\n\`\`\`` : ""
  }`;
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

const CODEMODE_FENCE_RE = /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)\n```\s*$/;

export function extractCodemodeScriptFromAssistantResponse(content: string): string | null {
  const trimmed = content.trim();
  const fenced = CODEMODE_FENCE_RE.exec(trimmed);
  if (fenced) return normalizeAssistantCodemodeScript(fenced[1]);
  return unwrapLegacyAsyncArrow(trimmed);
}

function normalizeAssistantCodemodeScript(script: string): string | null {
  const trimmed = script.trim();
  if (!trimmed) return null;
  return unwrapLegacyAsyncArrow(trimmed) ?? trimmed;
}

function unwrapLegacyAsyncArrow(script: string): string | null {
  const trimmed = script.trim();
  const arrowPrefix = /^async\s*\(\s*\)\s*=>\s*\{/.exec(trimmed);
  if (arrowPrefix && trimmed.endsWith("}")) {
    return trimmed.slice(arrowPrefix[0].length, -1).trim();
  }

  const invokedPrefix = /^\(?\s*async\s*\(\s*\)\s*=>\s*\{/.exec(trimmed);
  if (!invokedPrefix || !/\}\s*\)?\s*\(\s*\)\s*;?\s*$/.test(trimmed)) return null;
  const end = trimmed.lastIndexOf("}");
  return trimmed.slice(invokedPrefix[0].length, end).trim();
}

export function reduceCodemode(
  event: AgentEvent,
  state: IterateAgentProcessorState,
): IterateAgentProcessorState | undefined {
  if (
    event.type === "events.iterate.com/agent/input-added" &&
    event.idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY
  ) {
    return state.hasAppendedCodemodePrompt ? state : { ...state, hasAppendedCodemodePrompt: true };
  }
  return undefined;
}

export async function codemodeAfterAppend(
  args: AfterAppendArgs<IterateAgentProcessorState> & { deps: CodemodeProcessorDeps },
): Promise<void> {
  const { append, state, event, deps } = args;

  if (!state.hasAppendedCodemodePrompt) {
    await append({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
        payload: {
          role: "user",
          content: CODEMODE_PRIMER_TEXT,
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
    });
    await appendRewrite({
      append,
      content: toolProviderExplainer(await deps.describeProviders()),
      idempotencyKey: CODEMODE_PROVIDER_EXPLAINER_IDEMPOTENCY_KEY,
    });
  }

  if (event.type === "events.iterate.com/agent/input-added") {
    if (event.payload?.role !== "assistant") return;
    const script = extractCodemodeScriptFromAssistantResponse(String(event.payload.content ?? ""));
    if (script == null) return;
    await append({
      event: {
        type: "events.iterate.com/codemode/block-added",
        payload: { script },
      },
    });
    return;
  }

  if (event.type === "events.iterate.com/codemode/tool-provider-config-updated") {
    await appendRewrite({
      append,
      content: toolProviderConfigMessage((event.payload ?? {}) as Record<string, any>),
      idempotencyKey: `iterate-agent:tool-provider:${String(event.payload?.slug ?? event.payload?.namespace ?? "unknown")}`,
    });
    return;
  }

  if (event.type === "events.iterate.com/codemode/block-added") {
    const t0 = Date.now();
    const result = await deps.executeScript(String(event.payload?.script ?? ""));
    await append({
      event: {
        type: "events.iterate.com/codemode/result-added",
        payload: {
          result: result.result,
          durationMs: Date.now() - t0,
          ...(result.error == null ? {} : { error: result.error }),
          ...(result.logs == null ? {} : { logs: result.logs }),
        },
      },
    });
    return;
  }

  if (event.type === "events.iterate.com/codemode/result-added") {
    if (state.pendingTriggerCount === 0 && args.runtime.inflight() === null) {
      await append({
        event: {
          type: "events.iterate.com/agent/status-updated",
          payload: { status: "idle", reason: "events.iterate.com/codemode/result-added" },
        },
      });
    }
    if (event.offset == null) return;
    await append({
      event: {
        type: "events.iterate.com/agent/input-added",
        payload: {
          role: "user",
          content: eventBlock({
            offset: event.offset,
            type: event.type,
            fields: {
              success: event.payload?.error == null,
              durationMs: Number(event.payload?.durationMs ?? 0),
            },
            valueFields: {
              result: event.payload?.result,
              ...(event.payload?.error == null ? {} : { error: event.payload.error }),
              ...(event.payload?.logs == null || event.payload.logs.length === 0
                ? {}
                : { logs: event.payload.logs }),
            },
          }),
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
    });
  }
}
