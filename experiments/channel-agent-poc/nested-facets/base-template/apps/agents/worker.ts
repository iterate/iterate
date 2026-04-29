import { DurableObject } from "cloudflare:workers";
import { Agent } from "agents";
import {
  buildLlmChatRequest,
  createIterateAgentProcessor,
  extractLlmAssistantText,
  type IterateAgentProcessorState,
  type ProcessorRuntime,
} from "./agent-processor.ts";
import { extractCodemodeScriptFromAssistantResponse } from "./codemode-processor.ts";

// ── SQL Studio helpers ──────────────────────────────────────────────────────

function sqlStudioHTML(name: string) {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    "<title>" +
    name +
    " — SQL Studio</title>" +
    "<style>*{margin:0;padding:0}body,html{height:100%;overflow:hidden}iframe{width:100%;height:100%;border:none}</style>" +
    "</head><body>" +
    '<iframe id="studio" src="https://libsqlstudio.com/embed/sqlite?name=' +
    encodeURIComponent(name) +
    '"></iframe>' +
    "<script>" +
    'window.addEventListener("message", async function(e) {' +
    '  if (e.source !== document.getElementById("studio").contentWindow) return;' +
    "  var msg = e.data;" +
    '  if (!msg || (msg.type !== "query" && msg.type !== "transaction")) return;' +
    "  try {" +
    '    var resp = await fetch("_sql", {' +
    '      method: "POST",' +
    '      headers: { "content-type": "application/json" },' +
    "      body: JSON.stringify(msg)" +
    "    });" +
    "    var result = await resp.json();" +
    '    e.source.postMessage(result, "*");' +
    "  } catch (err) {" +
    '    e.source.postMessage({ type: msg.type, id: msg.id, error: err.message }, "*");' +
    "  }" +
    "});" +
    "</script></body></html>"
  );
}

function runQuery(sql: any, statement: string) {
  const cursor = sql.exec(statement);
  const cols = cursor.columnNames;
  const rows = cursor.toArray();
  const headers = cols.map((n: string) => ({
    name: n,
    displayName: n,
    originalType: null,
    type: 1,
  }));
  return {
    rows,
    headers,
    stat: {
      rowsAffected: cursor.rowsWritten,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      queryDurationMs: 0,
    },
    lastInsertRowid: 0,
  };
}

// Extract pathname from a URL string without using new URL() (unavailable in dynamic workers)
function getPathname(urlStr: string): string {
  // "https://host:port/path?query" → "/path"
  const afterProto = urlStr.replace(/^https?:\/\//, "");
  const slashIdx = afterProto.indexOf("/");
  if (slashIdx === -1) return "/";
  const questionIdx = afterProto.indexOf("?", slashIdx);
  return questionIdx === -1 ? afterProto.slice(slashIdx) : afterProto.slice(slashIdx, questionIdx);
}

function parseQuery(urlStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  const qIdx = urlStr.indexOf("?");
  if (qIdx === -1) return params;
  for (const pair of urlStr.slice(qIdx + 1).split("&")) {
    const [key, value] = pair.split("=");
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(value ?? "");
  }
  return params;
}

function normalizeStreamPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/agents/webchat";
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

async function handleSqlExec(sql: any, req: Request) {
  const msg = (await req.json()) as any;
  try {
    if (msg.type === "query") {
      return Response.json({ type: "query", id: msg.id, data: runQuery(sql, msg.statement) });
    }
    if (msg.type === "transaction") {
      const results = msg.statements.map((s: string) => runQuery(sql, s));
      return Response.json({ type: "transaction", id: msg.id, data: results });
    }
    return Response.json({ error: "unknown type" }, { status: 400 });
  } catch (err: any) {
    return Response.json({ type: msg.type, id: msg.id, error: err.message });
  }
}

// ── StreamProcessor — thin host for the evented agent processor ─────────────

const AGENT_MODEL = "@cf/moonshotai/kimi-k2.5";
const PLATFORM_SUFFIX = ".iterate-dev-jonas.app";
const PROCESSOR_STATE_KEY = "iterate-agent:processor-state";
const CODEMODE_REPAIR_MARKER = "[codemode-repair-request]";

function appUrl(appName: string, projectSlug: string): string {
  return `https://${appName}.${projectSlug}${PLATFORM_SUFFIX}`;
}

type ToolProvider = {
  name: string;
  fns: Record<string, (...args: any[]) => Promise<any>>;
  types?: string;
};

function providerTypes(name: string, tools: string[]): string {
  const methods = tools.map((tool) => `  ${tool}(args?: unknown): Promise<unknown>;`).join("\n");
  return `declare const ${name}: {\n${methods}\n};`;
}

function providerNamesForStream(streamPath: string): Set<string> {
  if (streamPath.startsWith("/agents/webchat")) return new Set(["webchat"]);
  if (streamPath.startsWith("/agents/slack/")) return new Set(["slack"]);
  if (streamPath.startsWith("/agents/github/")) return new Set(["github"]);
  if (streamPath.startsWith("/agents/linear/")) return new Set(["linear"]);
  if (streamPath.startsWith("/agents/discord/")) return new Set(["discord"]);
  return new Set(["webchat", "slack", "github", "linear", "discord"]);
}

function hasRecentCodemodeRepairRequest(state: IterateAgentProcessorState): boolean {
  return state.history
    .slice(-4)
    .some((item) => item.role === "user" && item.content.includes(CODEMODE_REPAIR_MARKER));
}

function invalidCodemodeFailurePayload(args: {
  requestId: string;
  startedAt: number;
  raw: unknown;
  state: IterateAgentProcessorState;
}) {
  return {
    requestId: args.requestId,
    durationMs: Date.now() - args.startedAt,
    error: {
      code: "invalid-codemode-response",
      message: "LLM response did not contain one complete fenced js codemode block",
    },
    recoverable: !hasRecentCodemodeRepairRequest(args.state),
    raw: args.raw,
  };
}

function schemaToTs(schema: any, indent = 2): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value: unknown) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(schema.oneOf))
    return schema.oneOf.map((s: any) => schemaToTs(s, indent)).join(" | ");
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.map((s: any) => schemaToTs(s, indent)).join(" | ");
  if (schema.type === "array") return `Array<${schemaToTs(schema.items, indent)}>`;
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "string") return "string";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "object" || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    const pad = " ".repeat(indent);
    const childPad = " ".repeat(indent + 2);
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length === 0) return "Record<string, unknown>";
    return [
      "{",
      ...properties.flatMap(([key, value]: [string, any]) => [
        ...(value.description
          ? [`${childPad}/** ${String(value.description).replaceAll("*/", "* /")} */`]
          : []),
        `${childPad}${key}${required.has(key) ? "" : "?"}: ${schemaToTs(value, indent + 2)};`,
      ]),
      `${pad}}`,
    ].join("\n");
  }
  return "unknown";
}

function openApiSchema(op: any, status?: string): any {
  if (status == null) {
    return op?.requestBody?.content?.["application/json"]?.schema;
  }
  return op?.responses?.[status]?.content?.["application/json"]?.schema;
}

type OpenApiOperation = {
  name: string;
  description?: string;
  requestSchema?: any;
  responseSchema?: any;
};

type OperationTree = {
  children: Map<string, OperationTree>;
  operation?: OpenApiOperation;
};

function sanitizeToolName(name: string): string {
  if (!name) return "_";
  let sanitized = name.replace(/[-.\s]/g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) sanitized = "_" + sanitized;
  return sanitized;
}

function sanitizePropertyName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) return "_" + sanitized;
  return sanitized;
}

function operationSignature(
  operation: OpenApiOperation,
  propertyName: string,
  indent: number,
): string[] {
  const pad = " ".repeat(indent);
  const requestType = schemaToTs(operation.requestSchema, indent + 2);
  const responseType = schemaToTs(operation.responseSchema, indent + 2);
  return [
    ...(operation.description
      ? [`${pad}/** ${String(operation.description).replaceAll("*/", "* /")} */`]
      : []),
    `${pad}${propertyName}(args: ${requestType}): Promise<${responseType}>;`,
  ];
}

function renderOperationTree(node: OperationTree, indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [name, child] of node.children) {
    if (child.operation && child.children.size === 0) {
      lines.push(...operationSignature(child.operation, name, indent));
      continue;
    }
    lines.push(`${pad}${name}: {`);
    lines.push(...renderOperationTree(child, indent + 2));
    lines.push(`${pad}};`);
  }
  return lines;
}

function openApiProviderTypes(name: string, operations: OpenApiOperation[]): string {
  const root: OperationTree = { children: new Map() };
  for (const operation of operations) {
    const parts = operation.name.split(".").map(sanitizePropertyName);
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.operation = operation;
  }
  return `declare const ${name}: {\n${renderOperationTree(root, 2).join("\n")}\n};`;
}

function rewriteDottedProviderCalls(script: string, providers: ToolProvider[]): string {
  let rewritten = script;
  for (const provider of providers) {
    for (const toolName of Object.keys(provider.fns)) {
      if (!toolName.includes(".")) continue;
      const escapedPath = toolName
        .split(".")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\.");
      const pattern = new RegExp(`\\b${provider.name}\\.${escapedPath}\\s*\\(`, "g");
      rewritten = rewritten.replace(pattern, `${provider.name}.${sanitizeToolName(toolName)}(`);
    }
  }
  return rewritten;
}

// ── Minimal OpenAPI → tool provider ──────────────────────────────────────────
// Fetches an OpenAPI spec and creates a { name, fns } provider where each
// operation becomes an async function that calls the API via fetch.

async function createOpenApiProvider(
  name: string,
  specUrl: string,
  baseUrl: string,
): Promise<ToolProvider> {
  const specResp = await fetch(specUrl);
  const spec = (await specResp.json()) as any;
  const fns: Record<string, (...args: any[]) => Promise<any>> = {};
  const operations: OpenApiOperation[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? ({} as Record<string, any>))) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = (pathItem as any)?.[method];
      if (!op?.operationId) continue;
      const toolName = String(op.operationId).replace(/[^a-zA-Z0-9_.$]/g, "_");
      const parameters = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];
      operations.push({
        name: toolName,
        description: op.description || op.summary,
        requestSchema: openApiSchema(op),
        responseSchema: openApiSchema(op, "200"),
      });

      fns[toolName] = async (input: any) => {
        const args = { ...(input && typeof input === "object" ? input : {}) };
        let resolvedPath = path;

        // Substitute path parameters
        for (const param of parameters) {
          if (param.in === "path" && param.name && args[param.name] != null) {
            resolvedPath = resolvedPath.replaceAll(
              `{${param.name}}`,
              encodeURIComponent(String(args[param.name])),
            );
            delete args[param.name];
          }
        }

        // Build query string
        const queryParams: string[] = [];
        for (const param of parameters) {
          if (param.in === "query" && param.name && args[param.name] != null) {
            queryParams.push(`${param.name}=${encodeURIComponent(String(args[param.name]))}`);
            delete args[param.name];
          }
        }

        const url =
          baseUrl.replace(/\/+$/, "") +
          resolvedPath +
          (queryParams.length ? "?" + queryParams.join("&") : "");
        const init: RequestInit = { method: method.toUpperCase() };
        if (method !== "get" && Object.keys(args).length > 0) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(args);
        }

        const resp = await fetch(url, init);
        const text = await resp.text();
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      };
    }
  }

  return { name, fns, types: openApiProviderTypes(name, operations) };
}

// MCP servers registered via Agent SDK's this.addMcpServer()
const MCP_SERVERS = [
  { name: "cloudflare_docs", url: "https://docs.mcp.cloudflare.com/mcp" },
  { name: "canuckduck", url: "https://mcp.canuckduck.ca/mcp" },
] as const;

export class StreamProcessor extends Agent {
  #openApiProviders: ToolProvider[] = [];
  #inflight: { requestId: string; status: "scheduled" | "running"; timer?: any } | null = null;
  #deadlineTimers = new Map<string, any>();
  #processor = createIterateAgentProcessor({
    executeScript: (script) => this.executeCode(script),
    describeProviders: async () => {
      const providers = await this.buildProviders();
      return providers.map((provider) => ({
        name: provider.name,
        tools: Object.keys(provider.fns),
        types: provider.types,
      }));
    },
  });

  async onStart() {
    console.log("[StreamProcessor] onStart");

    try {
      // Register MCP servers (same pattern as IterateAgent.onStart)
      const existingUrls = new Set(this.mcp.listServers().map((s: any) => s.server_url));
      const toAdd = MCP_SERVERS.filter((s) => !existingUrls.has(s.url));
      await Promise.allSettled(
        toAdd.map(async (s) => {
          try {
            await this.addMcpServer(s.name, s.url);
            console.log("[MCP] added:", s.name);
          } catch (e: any) {
            console.error("[MCP] failed:", s.name, e.message);
          }
        }),
      );

      // Load OpenAPI tool providers from sibling apps
      const slug = ((await this.ctx.storage.kv.get("projectSlug")) as string) || "test";
      for (const [name, appName] of [
        ["tanstack_app", "tanstack-app"],
        ["slack", "slack"],
        ["linear", "linear"],
        ["github", "github"],
        ["discord", "discord"],
      ] as const) {
        try {
          const base = appUrl(appName, slug) + "/api";
          const provider = await createOpenApiProvider(name, base + "/openapi.json", base);
          this.#openApiProviders.push(provider);
          console.log(`[OpenAPI] ${name}:`, Object.keys(provider.fns).join(", "));
        } catch (e: any) {
          console.error(`[OpenAPI] ${name} failed:`, e.message);
        }
      }
    } catch (e: any) {
      // In facet context, broadcastMcpServers may fail due to DO I/O isolation
      // (WebSocket connections belong to parent DO). Safe to ignore — onRequest still works.
      console.error("[StreamProcessor] onStart error (may be facet I/O isolation):", e.message);
    }
  }

  ensureTable() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        role TEXT,
        content TEXT,
        payload TEXT NOT NULL,
        offset INTEGER,
        stream_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  get sp(): string {
    return (this.ctx.storage.kv.get("streamPath") as string) || "unknown";
  }

  getHistory(): Array<{ role: string; content: string }> {
    return this.#state().history;
  }

  storeEvent(
    type: string,
    role: string | null,
    content: string | null,
    payload: any,
    offset?: number | null,
  ) {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (type, role, content, payload, offset, stream_path) VALUES (?, ?, ?, ?, ?, ?)",
      type,
      role,
      content,
      JSON.stringify(payload),
      offset ?? null,
      this.sp,
    );
  }

  #state(): IterateAgentProcessorState {
    const stored = this.ctx.storage.kv.get(PROCESSOR_STATE_KEY) as
      | IterateAgentProcessorState
      | undefined;
    if (stored) return stored;
    return JSON.parse(JSON.stringify(this.#processor.initialState));
  }

  #putState(state: IterateAgentProcessorState) {
    this.ctx.storage.kv.put(PROCESSOR_STATE_KEY, state);
  }

  #reduceAndStore(event: any): IterateAgentProcessorState {
    const current = this.#state();
    const reduced = this.#processor.reduce({ event, state: current });
    const next = reduced ?? current;
    this.#putState(next);
    return next;
  }

  #eventsApiBase(): string {
    const fromConfig =
      (this.ctx.storage.kv.get("eventsBaseUrl") as string) || "https://events.iterate.com";
    const projectSlug = (this.ctx.storage.kv.get("projectSlug") as string) || "";
    const base = fromConfig.replace(/\/+$/, "");
    return (projectSlug ? base.replace("://", `://${projectSlug}.`) : base) + "/api";
  }

  async #processEvent(event: any): Promise<any[]> {
    if (event.offset != null) {
      const seen = this.ctx.storage.sql
        .exec(
          "SELECT id FROM events WHERE offset = ? AND stream_path = ? LIMIT 1",
          event.offset,
          this.sp,
        )
        .toArray();
      if (seen.length > 0) {
        if (event.type === "events.iterate.com/llm/request-scheduled" && event.payload?.requestId) {
          const started = this.ctx.storage.sql
            .exec(
              "SELECT id FROM events WHERE type = ? AND payload LIKE ? AND stream_path = ? LIMIT 1",
              "events.iterate.com/llm/request-started",
              `%${event.payload.requestId}%`,
              this.sp,
            )
            .toArray();
          if (started.length === 0) {
            this.#inflight = { requestId: event.payload.requestId, status: "scheduled" };
            await this.#runLlmRequest(event.payload.requestId);
          }
        }
        return [];
      }
    }

    this.storeEvent(
      event.type || "unknown",
      event.payload?.role || null,
      event.payload?.content || null,
      event.payload || {},
      event.offset ?? null,
    );

    const appends: any[] = [];
    const collect = (evt: any) => appends.push(evt);

    const nextState = this.#reduceAndStore(event);
    await this.#processor.afterAppend({
      event,
      state: nextState,
      runtime: this.#runtime(),
      append: ({ event }) => collect(event),
    });

    const scheduledRequests = appends.filter(
      (append) =>
        append.type === "events.iterate.com/llm/request-scheduled" && append.payload?.requestId,
    );
    for (const scheduled of scheduledRequests) {
      const requestId = scheduled.payload.requestId;
      this.#inflight = { requestId, status: "running" };
      appends.push(...(await this.#buildLlmRequestAppends(requestId)));
    }

    return appends;
  }

  async #buildLlmRequestAppends(requestId: string): Promise<any[]> {
    const state = this.#state();
    const body = buildLlmChatRequest(state);
    const startedAt = Date.now();
    const startedEvent = {
      type: "events.iterate.com/llm/request-started",
      payload: {
        requestId,
        model: state.llmConfig.model,
        body,
        runOpts: state.llmConfig.runOpts,
      },
      idempotencyKey: `llm-started:${requestId}`,
    };

    let raw: unknown = undefined;
    try {
      const ai = (this as any).env.AI;
      if (!ai || typeof ai.run !== "function") {
        throw new Error("AI binding missing or no .run(): " + typeof ai);
      }
      raw = await ai.run(state.llmConfig.model || AGENT_MODEL, {
        ...body,
        max_tokens: 2048,
        ...(state.llmConfig.runOpts ?? {}),
      });
      const content = extractLlmAssistantText(raw);
      const assistantEvent = {
        type: "events.iterate.com/agent/input-added",
        payload: { role: "assistant", content },
        idempotencyKey: `llm-assistant:${requestId}`,
      };
      if (extractCodemodeScriptFromAssistantResponse(content) == null) {
        return [
          startedEvent,
          assistantEvent,
          {
            type: "events.iterate.com/llm/request-failed",
            payload: invalidCodemodeFailurePayload({ requestId, startedAt, raw, state }),
            idempotencyKey: `llm-failed:${requestId}`,
          },
        ];
      }
      return [
        startedEvent,
        assistantEvent,
        {
          type: "events.iterate.com/llm/request-completed",
          payload: { requestId, durationMs: Date.now() - startedAt, raw },
          idempotencyKey: `llm-completed:${requestId}`,
        },
      ];
    } catch (error: any) {
      return [
        startedEvent,
        {
          type: "events.iterate.com/llm/request-failed",
          payload: {
            requestId,
            durationMs: Date.now() - startedAt,
            error: { message: error?.message || String(error) },
            raw,
          },
          idempotencyKey: `llm-failed:${requestId}`,
        },
      ];
    } finally {
      if (this.#inflight?.requestId === requestId) this.#inflight = null;
    }
  }

  async #appendToStream(event: any, depth = 0): Promise<any> {
    const resp = await fetch(`${this.#eventsApiBase()}/streams/${encodeURIComponent(this.sp)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
    if (!resp.ok) {
      throw new Error(`append ${event?.type || "event"} failed: ${resp.status}`);
    }
    const json = (await resp.json()) as any;
    const appendedEvent = json.event ?? event;
    if (appendedEvent?.offset != null && depth < 20) {
      const appends = await this.#processEvent(appendedEvent);
      for (const append of appends) {
        await this.#appendToStream(append, depth + 1);
      }
    }
    return appendedEvent;
  }

  #runtime(): ProcessorRuntime {
    return {
      inflight: () =>
        this.#inflight == null
          ? null
          : { requestId: this.#inflight.requestId, status: this.#inflight.status },
      scheduleLlmRequest: ({ debounceMs }) => {
        const requestId = crypto.randomUUID();
        this.#inflight = { requestId, status: "scheduled" };
        return { requestId };
      },
      extendDebounce: ({ requestId, debounceMs }) => {
        if (this.#inflight?.requestId !== requestId || this.#inflight.status !== "scheduled")
          return;
      },
      cancelLlmRequest: ({ requestId }) => {
        if (this.#inflight?.requestId !== requestId) return;
        if (this.#inflight.timer) clearTimeout(this.#inflight.timer);
        this.#inflight = null;
      },
      armCancelDeadline: ({ requestId, withinMs }) => {
        const existing = this.#deadlineTimers.get(requestId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          if (this.#inflight?.requestId !== requestId) return;
          if (this.#inflight.timer) clearTimeout(this.#inflight.timer);
          this.#inflight = null;
          this.#appendToStream({
            type: "events.iterate.com/llm/request-cancelled",
            payload: { requestId, reason: "deadline-exceeded" },
            idempotencyKey: `llm-cancel-deadline:${requestId}`,
          }).catch((error: any) =>
            console.error(
              "[Agent] deadline cancel append failed:",
              error?.message || String(error),
            ),
          );
        }, withinMs);
        this.#deadlineTimers.set(requestId, timer);
      },
    };
  }

  async #runLlmRequest(requestId: string): Promise<void> {
    if (this.#inflight?.requestId !== requestId) return;
    this.#inflight = { requestId, status: "running" };

    const state = this.#state();
    const body = buildLlmChatRequest(state);
    const startedAt = Date.now();

    await this.#appendToStream({
      type: "events.iterate.com/llm/request-started",
      payload: {
        requestId,
        model: state.llmConfig.model,
        body,
        runOpts: state.llmConfig.runOpts,
      },
      idempotencyKey: `llm-started:${requestId}`,
    });

    let raw: unknown = undefined;
    try {
      const ai = (this as any).env.AI;
      if (!ai || typeof ai.run !== "function") {
        throw new Error("AI binding missing or no .run(): " + typeof ai);
      }
      raw = await ai.run(state.llmConfig.model || AGENT_MODEL, {
        ...body,
        max_tokens: 2048,
        ...(state.llmConfig.runOpts ?? {}),
      });
      if (this.#inflight?.requestId !== requestId) return;
      const content = extractLlmAssistantText(raw);
      await this.#appendToStream({
        type: "events.iterate.com/agent/input-added",
        payload: { role: "assistant", content },
        idempotencyKey: `llm-assistant:${requestId}`,
      });
      if (extractCodemodeScriptFromAssistantResponse(content) == null) {
        await this.#appendToStream({
          type: "events.iterate.com/llm/request-failed",
          payload: invalidCodemodeFailurePayload({ requestId, startedAt, raw, state }),
          idempotencyKey: `llm-failed:${requestId}`,
        });
        return;
      }
      await this.#appendToStream({
        type: "events.iterate.com/llm/request-completed",
        payload: { requestId, durationMs: Date.now() - startedAt, raw },
        idempotencyKey: `llm-completed:${requestId}`,
      });
    } catch (error: any) {
      await this.#appendToStream({
        type: "events.iterate.com/llm/request-failed",
        payload: {
          requestId,
          durationMs: Date.now() - startedAt,
          error: { message: error?.message || String(error) },
          raw,
        },
        idempotencyKey: `llm-failed:${requestId}`,
      });
    } finally {
      if (this.#inflight?.requestId === requestId) this.#inflight = null;
      const deadline = this.#deadlineTimers.get(requestId);
      if (deadline) clearTimeout(deadline);
      this.#deadlineTimers.delete(requestId);
    }
  }

  // Build tool providers — closures that close over this DO's bindings.
  // When passed to CodeExecutor via RPC, these become RPC stubs.
  // DynamicWorkerExecutor wraps them in ToolDispatchers.
  // Sandbox calls go: Isolate 3 → ToolDispatcher (Isolate 1) → RPC stub → here (Isolate 2)
  async buildProviders(): Promise<ToolProvider[]> {
    const allowedProviders = providerNamesForStream(this.sp);
    const providers: ToolProvider[] = [
      // Canary + debug tools
      {
        name: "builtin",
        types: `declare const builtin: {
  answer(): Promise<42>;
  mcpStatus(): Promise<{ servers: number; tools: number; hasMcp: string } | { error: string }>;
};`,
        fns: {
          answer: async () => 42,
          mcpStatus: async () => {
            try {
              const servers = this.mcp.listServers();
              const tools = this.mcp.listTools();
              return { servers: servers.length, tools: tools.length, hasMcp: typeof this.mcp };
            } catch (e: any) {
              return { error: e.message };
            }
          },
        },
      },
    ];

    if (allowedProviders.has("webchat")) {
      providers.push({
        name: "webchat",
        types: `declare const webchat: {
  sendMessage(args: { message: string }): Promise<{ ok: true }>;
};`,
        fns: {
          sendMessage: async (args: any) => {
            const input = Array.isArray(args) ? args[0] : args;
            const message = String(input?.message ?? "");
            if (!message) throw new Error("webchat.sendMessage requires message");
            await this.#appendToStream({
              type: "events.iterate.com/webchat/response-added",
              payload: { message },
              idempotencyKey: `webchat-response:${crypto.randomUUID()}`,
            });
            return { ok: true };
          },
        },
      });
    }

    // OpenAPI tool providers from sibling apps
    const slug = ((await this.ctx.storage.kv.get("projectSlug")) as string) || "test";
    for (const [name, appName] of [
      ["tanstack_app", "tanstack-app"],
      ["slack", "slack"],
      ["linear", "linear"],
      ["github", "github"],
      ["discord", "discord"],
    ] as const) {
      if (!allowedProviders.has(name)) continue;
      try {
        const base = appUrl(appName, slug) + "/api";
        const p = await createOpenApiProvider(name, base + "/openapi.json", base);
        providers.push(p);
      } catch (e: any) {
        console.error(`[OpenAPI] ${name} failed:`, e.message);
      }
    }

    console.log(
      "[buildProviders] total:",
      providers.length,
      "names:",
      providers.map((p) => p.name),
    );
    return providers;
  }

  async executeCode(
    script: string,
  ): Promise<{ result?: unknown; error?: string; logs?: string[] }> {
    try {
      const providers = await this.buildProviders();
      return await (this as any).env.EXEC.execute(
        rewriteDottedProviderCalls(script, providers),
        providers,
      );
    } catch (err: any) {
      return { error: err.message };
    }
  }

  // Agent lifecycle: onRequest handles non-WebSocket HTTP (Agent calls onStart first)
  async onRequest(req: Request): Promise<Response> {
    this.ensureTable();
    const pathname = getPathname(req.url);
    const streamPath = (this.ctx.storage.kv.get("streamPath") as string) || "unknown";

    // SQL Studio
    if (pathname === "/_studio") {
      return new Response(sqlStudioHTML("StreamProcessor: " + streamPath), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (req.method === "POST" && pathname === "/_sql") {
      return handleSqlExec(this.ctx.storage.sql, req);
    }

    // WebSocket upgrade — events.iterate.com connects here
    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      console.log("[StreamProcessor] WebSocket accepted for stream:", streamPath);
      // Send a welcome message to confirm the connection works
      pair[1].send(JSON.stringify({ type: "connected", stream: streamPath }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /api/test-providers — debug: build and list providers
    if (req.method === "GET" && pathname === "/api/test-providers") {
      try {
        const providers = await this.buildProviders();
        return Response.json({
          ok: true,
          providers: providers.map((p) => ({ name: p.name, tools: Object.keys(p.fns) })),
        });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    // POST /process — process an event, return append events
    if (req.method === "POST" && pathname === "/process") {
      const event = (await req.json()) as any;

      try {
        const appends = await this.#processEvent(event);
        return Response.json({ ok: true, appends });
      } catch (loopErr: any) {
        return Response.json({
          ok: true,
          appends: [
            {
              type: "events.iterate.com/agent/error",
              payload: { error: "processor:" + loopErr.message },
            },
          ],
        });
      }
    }

    // POST /api/init-mcp — force MCP initialization and return result
    if (req.method === "POST" && pathname === "/api/init-mcp") {
      try {
        // onStart() already registers servers, but this forces it for debugging
        const existingUrls = new Set(this.mcp.listServers().map((s: any) => s.server_url));
        const toAdd = MCP_SERVERS.filter((s) => !existingUrls.has(s.url));
        const log: string[] = [];
        for (const s of toAdd) {
          try {
            await this.mcp.connect(s.url, { name: s.name });
            log.push(`${s.name}: added`);
          } catch (e: any) {
            log.push(`${s.name}: FAILED: ${e.message}`);
          }
        }
        await this.mcp.waitForConnections({ timeout: 15_000 });
        return Response.json({
          ok: true,
          servers: this.mcp.listServers().length,
          tools: this.mcp.listTools().map((t: any) => t.name),
          log,
        });
      } catch (e: any) {
        return Response.json({
          ok: false,
          error: e.message,
          stack: e.stack?.split("\n").slice(0, 3),
        });
      }
    }

    // GET /api/debug-mcp — test MCP status
    if (req.method === "GET" && pathname === "/api/debug-mcp") {
      try {
        const servers = this.mcp.listServers();
        const tools = this.mcp.listTools();
        return Response.json({
          ok: true,
          servers: servers.length,
          tools: tools.map((t: any) => t.serverId + ":" + t.name),
        });
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    // POST /init — set stream path + project slug
    if (req.method === "POST" && pathname === "/init") {
      const body = (await req.json()) as any;
      if (body._setStreamPath) this.ctx.storage.kv.put("streamPath", body._setStreamPath);
      if (body._projectSlug) this.ctx.storage.kv.put("projectSlug", body._projectSlug);
      if (body._eventsBaseUrl) this.ctx.storage.kv.put("eventsBaseUrl", body._eventsBaseUrl);
      return Response.json({ ok: true });
    }

    // GET /api/events
    if (req.method === "GET" && pathname === "/api/events") {
      const events = this.ctx.storage.sql
        .exec("SELECT * FROM events ORDER BY id DESC LIMIT 100")
        .toArray();
      return Response.json({ events, streamPath });
    }

    // GET /api/history — chat history for the LLM
    if (req.method === "GET" && pathname === "/api/history") {
      return Response.json({ history: this.getHistory(), streamPath });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}

// ── App — main DO, serves React SPA, manages subscriptions ──

export class App extends DurableObject {
  // Construct the events API base URL for this project
  #eventsApiBase(eventsBaseUrl?: string, projectSlug?: string): string {
    // Prefer EVENTS_API_BASE from dynamic worker env (set by Project DO)
    const fromEnv = (this as any).env?.EVENTS_API_BASE;
    if (fromEnv) return fromEnv + "/api";
    // Fallback: construct from config
    const base = (eventsBaseUrl || "https://events.iterate.com").replace(/\/+$/, "");
    const slug = projectSlug || "";
    return (slug ? base.replace("://", `://${slug}.`) : base) + "/api";
  }

  async #appendToStream(path: string, event: any, eventsBaseUrl?: string, projectSlug?: string) {
    const apiBase = this.#eventsApiBase(eventsBaseUrl, projectSlug);
    const resp = await fetch(`${apiBase}/streams/${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
    return resp;
  }

  async #appendToStreamJson(
    path: string,
    event: any,
    eventsBaseUrl?: string,
    projectSlug?: string,
  ): Promise<any> {
    const resp = await this.#appendToStream(path, event, eventsBaseUrl, projectSlug);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`append ${event?.type || "event"} failed: ${resp.status}`);
    try {
      return JSON.parse(text).event ?? event;
    } catch {
      return event;
    }
  }

  #configValue(key: string): string {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = ?", key).toArray();
    return rows.length ? (rows[0].value as string) : "";
  }

  #hostProjectSlug(req: Request): string {
    const host = req.headers.get("host") || "";
    const match = host.match(/^agents\.([^.]+)\./);
    return match?.[1] || "";
  }

  async #buildProvidersForStream(streamPath: string, req: Request): Promise<ToolProvider[]> {
    const allowedProviders = providerNamesForStream(streamPath);
    const projectSlug = this.#configValue("projectSlug") || this.#hostProjectSlug(req) || "test";
    const providers: ToolProvider[] = [];

    for (const [name, appName] of [
      ["tanstack_app", "tanstack-app"],
      ["slack", "slack"],
      ["linear", "linear"],
      ["github", "github"],
      ["discord", "discord"],
    ] as const) {
      if (!allowedProviders.has(name)) continue;
      const base = appUrl(appName, projectSlug) + "/api";
      providers.push(await createOpenApiProvider(name, base + "/openapi.json", base));
    }

    return providers;
  }

  async #executeCodemodeForStream(
    streamPath: string,
    script: string,
    req: Request,
  ): Promise<{ result?: unknown; error?: string; logs?: string[] }> {
    try {
      const providers = await this.#buildProvidersForStream(streamPath, req);
      return await (this as any).env.EXEC.execute(
        rewriteDottedProviderCalls(script, providers),
        providers,
      );
    } catch (error: any) {
      return { error: error?.message || String(error), logs: [] };
    }
  }

  async #fallbackProcessAssistantCodemode(
    streamPath: string,
    sourceEvent: any,
    req: Request,
  ): Promise<{ published: number; events: any[] } | null> {
    if (sourceEvent?.type !== "events.iterate.com/agent/input-added") return null;
    if (sourceEvent?.payload?.role !== "assistant") return null;

    const script = extractCodemodeScriptFromAssistantResponse(
      String(sourceEvent?.payload?.content ?? ""),
    );
    if (script == null) return null;

    const eventsBaseUrl = this.#configValue("eventsBaseUrl") || undefined;
    const projectSlug = this.#configValue("projectSlug") || this.#hostProjectSlug(req) || undefined;
    const sourceKey = String(sourceEvent?.idempotencyKey || sourceEvent?.offset || Date.now());
    const blockEvent = {
      type: "events.iterate.com/codemode/block-added",
      idempotencyKey: `agent-output:${sourceKey}:fallback:events.iterate.com/codemode/block-added`,
      payload: { script },
    };
    const resultPayload = await this.#executeCodemodeForStream(streamPath, script, req);
    const resultEvent = {
      type: "events.iterate.com/codemode/result-added",
      idempotencyKey: `agent-output:${sourceKey}:fallback:events.iterate.com/codemode/result-added`,
      payload: resultPayload,
    };
    const rewriteEvent = {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `agent-output:${sourceKey}:fallback:events.iterate.com/agent/input-added`,
      payload: {
        role: "user",
        content: `[Codemode result]:\n${JSON.stringify(resultPayload, null, 2)}`,
      },
    };

    const appended: any[] = [];
    for (const event of [blockEvent, resultEvent, rewriteEvent]) {
      appended.push(await this.#appendToStreamJson(streamPath, event, eventsBaseUrl, projectSlug));
    }

    return { published: appended.length, events: appended };
  }

  async #publishAgentAppends(
    streamPath: string,
    sourceEvent: any,
    appends: any[],
    req: Request,
    depth = 0,
    rootSourceKey = String(sourceEvent?.idempotencyKey || sourceEvent?.offset || Date.now()),
    branchPath = "",
  ): Promise<{ published: number; processed: number; errors: string[] }> {
    const eventsBaseUrl = this.#configValue("eventsBaseUrl") || undefined;
    const projectSlug = this.#configValue("projectSlug") || this.#hostProjectSlug(req) || undefined;
    const errors: string[] = [];
    let published = 0;
    let processed = 0;

    for (let i = 0; i < appends.length; i++) {
      const generatedEvent = appends[i];
      const generatedPath = branchPath ? `${branchPath}.${i}` : String(i);
      const event = {
        ...generatedEvent,
        idempotencyKey:
          generatedEvent?.idempotencyKey ??
          `agent-output:${rootSourceKey}:${generatedPath}:${generatedEvent?.type || "event"}`,
      };

      try {
        const resp = await this.#appendToStream(streamPath, event, eventsBaseUrl, projectSlug);
        if (!resp.ok) {
          errors.push(`${generatedEvent?.type || "event"}:${resp.status}`);
          continue;
        }
        const text = await resp.text();
        let appendJson: any = null;
        try {
          appendJson = JSON.parse(text);
        } catch {}
        const appendedEvent = appendJson?.event ?? event;
        published++;
        if (depth >= 20 || appendedEvent?.offset == null) continue;

        const proc = this.getOrCreateStream(streamPath);
        const facetName = this.#streamFacetName(streamPath);
        await this.#initStreamProcessor(proc, facetName, streamPath);
        const processResp = await proc.fetch(
          this.facetRequest(facetName, "http://localhost/process", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(appendedEvent),
          }),
        );
        const processText = await processResp.text();
        let processJson: any = null;
        try {
          processJson = JSON.parse(processText);
        } catch {}
        if (!processResp.ok) {
          const fallback = await this.#fallbackProcessAssistantCodemode(
            streamPath,
            appendedEvent,
            req,
          );
          if (fallback) {
            published += fallback.published;
            continue;
          }
          errors.push(`${generatedEvent?.type || "event"}:process:${processResp.status}`);
          continue;
        }
        processed++;
        if (processJson?.appends?.length) {
          const nested = await this.#publishAgentAppends(
            streamPath,
            appendedEvent,
            processJson.appends,
            req,
            depth + 1,
            rootSourceKey,
            generatedPath,
          );
          published += nested.published;
          processed += nested.processed;
          errors.push(...nested.errors);
        }
      } catch (e: any) {
        const fallback = await this.#fallbackProcessAssistantCodemode(streamPath, event, req);
        if (fallback) {
          published += fallback.published;
          continue;
        }
        errors.push(`${generatedEvent?.type || "event"}:${e.message}`);
      }
    }

    return { published, processed, errors };
  }

  async #processAndPublish(streamPath: string, sourceEvent: any, req: Request): Promise<Response> {
    const proc = this.getOrCreateStream(streamPath);
    const facetName = this.#streamFacetName(streamPath);
    await this.#initStreamProcessor(proc, facetName, streamPath);

    const resp = await proc.fetch(
      this.facetRequest(facetName, "http://localhost/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sourceEvent),
      }),
    );
    const responseText = await resp.text();
    let responseJson: any = null;
    try {
      responseJson = JSON.parse(responseText);
    } catch {}

    if (responseJson?.appends?.length) {
      responseJson.publishedAppends = await this.#publishAgentAppends(
        streamPath,
        sourceEvent,
        responseJson.appends,
        req,
      );
      return Response.json(responseJson, { status: resp.status });
    }

    return new Response(responseText, { status: resp.status, headers: resp.headers });
  }

  ensureTables() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_path TEXT NOT NULL,
        events_base_url TEXT NOT NULL,
        events_project_slug TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        callback_url TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _facets (
        name TEXT PRIMARY KEY,
        class_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_fetch_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  /**
   * Build a Request targeting a StreamProcessor facet, injecting the
   * `x-partykit-room` header that partyserver's `Server.fetch()` requires
   * to set the DO name on first invocation.
   */
  facetRequest(facetName: string, url: string, init?: RequestInit): Request {
    const req = new Request(url, init);
    req.headers.set("x-partykit-room", facetName);
    return req;
  }

  #getProjectSlug(): string {
    const rows = this.ctx.storage.sql
      .exec("SELECT value FROM config WHERE key = 'projectSlug'")
      .toArray();
    return rows.length ? (rows[0].value as string) : "";
  }

  #streamGeneration(streamPath: string): string {
    return this.#configValue(`streamGeneration:${streamPath}`) || "0";
  }

  #streamFacetName(streamPath: string): string {
    return `stream:${streamPath}:g${this.#streamGeneration(streamPath)}`;
  }

  async #initStreamProcessor(proc: any, facetName: string, streamPath: string): Promise<void> {
    await proc.fetch(
      this.facetRequest(facetName, "http://localhost/init", {
        method: "POST",
        body: JSON.stringify({
          _setStreamPath: streamPath,
          _projectSlug: this.#getProjectSlug(),
          _eventsBaseUrl: this.#configValue("eventsBaseUrl") || "https://events.iterate.com",
        }),
      }),
    );
  }

  getOrCreateStream(streamPath: string) {
    const facetName = this.#streamFacetName(streamPath);

    this.ctx.storage.sql.exec(
      "INSERT INTO _facets (name, class_name) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_fetch_at = datetime('now')",
      facetName,
      "StreamProcessor",
    );

    const proc = this.ctx.facets.get(facetName, async () => {
      return { class: (this.ctx as any).exports.StreamProcessor };
    });

    proc
      .fetch(
        this.facetRequest(facetName, "http://localhost/init", {
          method: "POST",
          body: JSON.stringify({
            _setStreamPath: streamPath,
            _projectSlug: this.#getProjectSlug(),
            _eventsBaseUrl: this.#configValue("eventsBaseUrl") || "https://events.iterate.com",
          }),
        }),
      )
      .catch(() => {});

    return proc;
  }

  async fetch(req: Request): Promise<Response> {
    this.ensureTables();
    const pathname = getPathname(req.url);

    // SQL Studio
    if (pathname === "/_studio") {
      return new Response(sqlStudioHTML("App: agents"), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (req.method === "POST" && pathname === "/_sql") {
      return handleSqlExec(this.ctx.storage.sql, req);
    }

    // ── POST /_ws-message — WebSocket message dispatch from Project DO ──
    if (req.method === "POST" && pathname === "/_ws-message") {
      const body = (await req.json()) as { pathname: string; message: string };
      // Parse the stream path from the original WebSocket URL pathname
      // pathname is like /streams/%2Fagents%2Ftest/ws
      const wsPathMatch = body.pathname.match(/^\/streams\/([^/]+)/);
      if (!wsPathMatch) return Response.json({ appends: [] });
      const wsStreamPath = decodeURIComponent(wsPathMatch[1]);

      try {
        const frame = JSON.parse(body.message);
        if (frame.type !== "event" || !frame.event) return Response.json({ appends: [] });

        // Monitor: auto-subscribe to child streams under /agents/
        if (
          (wsStreamPath === "/agents/" || wsStreamPath === "/agents") &&
          (frame.event.type === "events.iterate.com/stream/child-stream-created" ||
            frame.event.type === "https://events.iterate.com/events/stream/child-stream-created") &&
          frame.event.payload?.childPath
        ) {
          const childPath = frame.event.payload.childPath as string;
          console.log("[Agents] child-stream-created (via _ws-message):", childPath);
          this.autoSubscribeChild(childPath).catch((e: any) =>
            console.error("[Agents] autoSubscribeChild error:", e.message),
          );
        }

        return this.#processAndPublish(wsStreamPath, frame.event, req);
      } catch (e: any) {
        return Response.json({ appends: [], error: e.message });
      }
    }

    // ── Streams routing: /streams/:encodedPath/... ──
    const streamsMatch = pathname.match(/^\/streams\/([^/]+)(\/.*)?$/);
    if (streamsMatch) {
      const streamPath = decodeURIComponent(streamsMatch[1]);
      const subPath = streamsMatch[2] || "/";
      const proc = this.getOrCreateStream(streamPath);

      // WebSocket upgrades are handled by the Project DO (which dispatches via _ws-message).
      // Do NOT accept WebSockets here — facets share the parent's context, so accepting
      // here would cause BOTH the Project DO's and App's webSocketMessage to fire,
      // resulting in duplicate event processing.

      const facetName = this.#streamFacetName(streamPath);
      await this.#initStreamProcessor(proc, facetName, streamPath);

      // /_studio + /_sql
      if (subPath === "/_studio") {
        return proc.fetch(this.facetRequest(facetName, "http://localhost/_studio"));
      }
      if (req.method === "POST" && subPath === "/_sql") {
        return proc.fetch(
          this.facetRequest(facetName, "http://localhost/_sql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: req.body,
          }),
        );
      }

      if (req.method === "POST" && subPath === "/process") {
        let sourceEvent: any = null;
        try {
          const bodyText = await req.text();
          try {
            sourceEvent = JSON.parse(bodyText);
          } catch {}
          return this.#processAndPublish(streamPath, sourceEvent, req);
        } catch (e: any) {
          const fallback = await this.#fallbackProcessAssistantCodemode(
            streamPath,
            sourceEvent,
            req,
          );
          if (fallback) {
            return Response.json({ ok: true, appends: [], fallback });
          }
          console.error(`[Agents] /process failed: ${e?.message || String(e)}`);
          return Response.json(
            { ok: false, error: e?.message || String(e), streamPath },
            { status: 500 },
          );
        }
      }

      // Forward other requests
      return proc.fetch(
        this.facetRequest(facetName, "http://localhost" + subPath, {
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body: req.body,
        }),
      );
    }

    // ── UI WebSocket ──
    if (req.headers.get("Upgrade") === "websocket" && pathname === "/api/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const subs = this.ctx.storage.sql
        .exec("SELECT * FROM subscriptions ORDER BY id DESC")
        .toArray();
      pair[1].send(JSON.stringify({ type: "sync", subscriptions: subs }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // ── GET /api/install — one-time setup: subscribe to /agents/ parent stream ──
    // The /agents/ stream receives child-stream-created events when new agent
    // streams are created (e.g. /agents/slack/ts-123). The monitor processor
    // auto-subscribes to each new child stream.
    if (pathname === "/api/install") {
      return this.handleInstall(req);
    }

    if (req.method === "GET" && pathname === "/api/webchat-config") {
      const projectSlug = this.#configValue("projectSlug") || this.#hostProjectSlug(req) || "test";
      return Response.json({
        defaultStreamPath: "/agents/webchat",
        projectSlug,
        eventsUrl: `https://${projectSlug}.events.iterate.com/streams/agents/webchat/?renderer=raw-pretty&composer=json`,
      });
    }

    if (req.method === "GET" && pathname === "/api/webchat-stream") {
      const streamPath = normalizeStreamPath(parseQuery(req.url).path ?? "/agents/webchat");
      const apiBase = this.#eventsApiBase();
      const upstream = await fetch(`${apiBase}/streams/${encodeURIComponent(streamPath)}`, {
        headers: { accept: "text/event-stream" },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/webchat-message") {
      const body = (await req.json()) as { streamPath?: string; content?: string };
      const streamPath = normalizeStreamPath(body.streamPath ?? "/agents/webchat");
      const content = String(body.content ?? "").trim();
      if (!content) return Response.json({ ok: false, error: "content required" }, { status: 400 });

      const event = {
        type: "events.iterate.com/webchat/message-received",
        payload: { content },
        idempotencyKey: `webchat-message:${crypto.randomUUID()}`,
      };

      const appendResp = await this.#appendToStream(streamPath, event);
      const appendText = await appendResp.text();
      let appendJson: any = null;
      try {
        appendJson = JSON.parse(appendText);
      } catch {}
      if (!appendResp.ok) {
        return Response.json(
          { ok: false, error: `append failed: ${appendResp.status}`, detail: appendText },
          { status: 502 },
        );
      }

      const sourceEvent = appendJson?.event ?? event;
      const processResp = await this.#processAndPublish(streamPath, sourceEvent, req);
      const processText = await processResp.text();
      let processJson: any = null;
      try {
        processJson = JSON.parse(processText);
      } catch {}
      if (!processResp.ok) {
        return Response.json(
          { ok: false, error: `process failed: ${processResp.status}`, detail: processText },
          { status: 502 },
        );
      }

      return Response.json({
        ok: true,
        streamPath,
        event: sourceEvent,
        process: processJson,
      });
    }

    // ── POST /api/subscribe — subscribe a stream to events.iterate.com ──
    if (req.method === "POST" && pathname === "/api/subscribe") {
      const body = (await req.json()) as {
        streamPath: string;
        eventsBaseUrl: string;
        eventsProjectSlug: string;
      };

      // Normalize stream path — must start with /
      const streamPath = body.streamPath.startsWith("/") ? body.streamPath : "/" + body.streamPath;
      const slug = "agent-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      // Avoid new URL() — may not be available in dynamically loaded workers
      const hostHeader = req.headers.get("host") || "localhost";
      const callbackUrl =
        "wss://" + hostHeader + "/streams/" + encodeURIComponent(streamPath) + "/ws";

      // Remove stale subscription for the same stream (prevents duplicate deliveries)
      this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE stream_path = ?", streamPath);

      // Store subscription
      this.ctx.storage.sql.exec(
        "INSERT INTO subscriptions (stream_path, events_base_url, events_project_slug, slug, callback_url) VALUES (?, ?, ?, ?, ?)",
        streamPath,
        body.eventsBaseUrl,
        body.eventsProjectSlug,
        slug,
        callbackUrl,
      );

      // Create the stream processor facet
      this.getOrCreateStream(streamPath);

      let appendError: string | null = null;
      try {
        await this.#appendToStream(
          streamPath,
          {
            type: "events.iterate.com/stream/subscription-configured",
            payload: { slug, type: "websocket", callbackUrl },
          },
          body.eventsBaseUrl,
          body.eventsProjectSlug,
        );
      } catch (e: any) {
        appendError = e.message;
      }

      this.broadcastSync();
      return Response.json({ ok: !appendError, slug, callbackUrl, error: appendError });
    }

    // ── GET /api/subscriptions ──
    if (req.method === "GET" && pathname === "/api/subscriptions") {
      const subs = this.ctx.storage.sql
        .exec("SELECT * FROM subscriptions ORDER BY id DESC")
        .toArray();
      return Response.json({ subscriptions: subs });
    }

    const resetStreamMatch = pathname.match(/^\/api\/reset-stream\/(.+)$/);
    if (req.method === "POST" && resetStreamMatch) {
      const streamPath = decodeURIComponent(resetStreamMatch[1]);
      const facetName = this.#streamFacetName(streamPath);
      try {
        (this.ctx as any).facets.abort(facetName, new Error("stream reset requested"));
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
      const nextGeneration = String(Number(this.#streamGeneration(streamPath)) + 1);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
        `streamGeneration:${streamPath}`,
        nextGeneration,
      );
      this.ctx.storage.sql.exec("DELETE FROM _facets WHERE name = ?", facetName);
      return Response.json({ ok: true, streamPath, generation: nextGeneration });
    }

    // ── GET /api/stream-events/:streamPath — events from a stream processor ──
    const streamEventsMatch = pathname.match(/^\/api\/stream-events\/(.+)$/);
    if (req.method === "GET" && streamEventsMatch) {
      const streamPath = decodeURIComponent(streamEventsMatch[1]);
      const proc = this.getOrCreateStream(streamPath);
      return proc.fetch(
        this.facetRequest(this.#streamFacetName(streamPath), "http://localhost/api/events"),
      );
    }

    // For anything else, return 404 — the Project DO serves the SPA from dist assets
    return new Response("Not found", { status: 404 });
  }

  // ── Install handler: subscribe to /agents/ parent stream ──────────
  async handleInstall(req: Request): Promise<Response> {
    this.ensureTables();
    const hostHeader = req.headers.get("host") || "localhost";
    const query: Record<string, string> = {};
    const qIdx = req.url.indexOf("?");
    if (qIdx !== -1) {
      for (const pair of req.url.slice(qIdx + 1).split("&")) {
        const [k, v] = pair.split("=");
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    }

    const eventsBaseUrl = query.eventsBaseUrl || "https://events.iterate.com";
    const projectSlug = query.projectSlug || "";

    if (!projectSlug) {
      return Response.json(
        {
          ok: false,
          error: "projectSlug is required",
          usage: "GET /api/install?projectSlug=myproject&eventsBaseUrl=https://events.iterate.com",
        },
        { status: 400 },
      );
    }

    // Store config for the monitor processor
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('eventsBaseUrl', ?)",
      eventsBaseUrl,
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('projectSlug', ?)",
      projectSlug,
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES ('hostHeader', ?)",
      hostHeader,
    );

    // Subscribe to /agents parent stream (only once — check config flag)
    const streamPath = "/agents";
    const slug = "agents-monitor";
    const callbackUrl =
      "wss://" + hostHeader + "/streams/" + encodeURIComponent(streamPath) + "/ws";
    const alreadyInstalled =
      this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = 'installed'").toArray()
        .length > 0;

    this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE slug = ?", slug);
    this.ctx.storage.sql.exec(
      "INSERT INTO subscriptions (stream_path, events_base_url, events_project_slug, slug, callback_url) VALUES (?, ?, ?, ?, ?)",
      streamPath,
      eventsBaseUrl,
      projectSlug,
      slug,
      callbackUrl,
    );
    this.getOrCreateStream(streamPath);

    let result: any = null;
    let error: string | null = null;

    if (!alreadyInstalled) {
      try {
        await this.#appendToStream(
          streamPath,
          {
            type: "events.iterate.com/stream/subscription-configured",
            payload: { slug, type: "websocket", callbackUrl },
          },
          eventsBaseUrl,
          projectSlug,
        );
      } catch (e: any) {
        error = e.message;
      }
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('installed', '1')",
      );
    } else {
      result = { skipped: true, reason: "already installed" };
    }

    this.broadcastSync();

    return Response.json({
      ok: !error,
      message: alreadyInstalled ? "Already installed (config updated)." : "Agents app installed.",
      subscription: { streamPath, callbackUrl, result, error },
    });
  }

  // ── Auto-subscribe to child streams discovered by the monitor ──────
  async autoSubscribeChild(childPath: string): Promise<void> {
    this.ensureTables();

    // Check if already subscribed
    const existing = this.ctx.storage.sql
      .exec("SELECT id FROM subscriptions WHERE stream_path = ? LIMIT 1", childPath)
      .toArray();
    if (existing.length > 0) {
      console.log("[Agents] already subscribed to", childPath);
      return;
    }

    // Read config
    const configRows = this.ctx.storage.sql.exec("SELECT key, value FROM config").toArray();
    const config: Record<string, string> = {};
    for (const row of configRows) config[row.key as string] = row.value as string;

    const eventsBaseUrl = config.eventsBaseUrl;
    const projectSlug = config.projectSlug;
    const hostHeader = config.hostHeader;

    if (!eventsBaseUrl || !projectSlug || !hostHeader) {
      console.error("[Agents] missing config — run /api/install first");
      return;
    }

    const slug = "agent-child-" + childPath.replace(/\//g, "-");
    const callbackUrl = "wss://" + hostHeader + "/streams/" + encodeURIComponent(childPath) + "/ws";

    this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE slug = ?", slug);
    this.ctx.storage.sql.exec(
      "INSERT INTO subscriptions (stream_path, events_base_url, events_project_slug, slug, callback_url) VALUES (?, ?, ?, ?, ?)",
      childPath,
      eventsBaseUrl,
      projectSlug,
      slug,
      callbackUrl,
    );
    this.getOrCreateStream(childPath);

    try {
      await this.#appendToStream(
        childPath,
        {
          type: "events.iterate.com/stream/subscription-configured",
          payload: { slug, type: "websocket", callbackUrl },
          idempotencyKey: `sub:${slug}`,
        },
        eventsBaseUrl,
        projectSlug,
      );
      console.log("[Agents] auto-subscribed to child:", childPath);
    } catch (e: any) {
      console.error("[Agents] subscribe error:", e.message);
    }

    this.broadcastSync();
  }

  broadcastSync() {
    const subs = this.ctx.storage.sql
      .exec("SELECT * FROM subscriptions ORDER BY id DESC")
      .toArray();
    const msg = JSON.stringify({ type: "sync", subscriptions: subs });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  // No webSocketMessage handler — WebSocket events are dispatched by the Project DO
  // via _ws-message (HTTP POST). Having both would cause duplicate processing because
  // facets share the parent DO's WebSocket context.
}
