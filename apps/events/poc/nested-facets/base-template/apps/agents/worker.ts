import { DurableObject } from "cloudflare:workers";
import { Agent } from "agents";

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

// ── StreamProcessor — agent loop with codemode tool calling ──────────────────
// Receives events via WebSocket from events.iterate.com. On user messages:
// 1. Calls Workers AI (Kimi K2.5) with full chat history
// 2. Parses triple-backtick code blocks from the response
// 3. Executes code blocks in sandboxed workers via CodeExecutor
// 4. Feeds results back to the AI for a follow-up response
// This creates an agentic loop: user → AI → code → result → AI → response

const AGENT_MODEL = "@cf/moonshotai/kimi-k2.5";
const PLATFORM_SUFFIX = ".iterate-dev-jonas.app";

function appUrl(appName: string, projectSlug: string): string {
  return `https://${appName}.${projectSlug}${PLATFORM_SUFFIX}`;
}

function buildSystemPrompt(providers: Array<{ name: string; fns: Record<string, any> }>): string {
  const toolList = providers
    .map((p) => {
      const tools = Object.keys(p.fns)
        .map((t) => `${p.name}.${t}(args)`)
        .join(", ");
      return `- \`${p.name}\`: ${tools}`;
    })
    .join("\n");

  return `You are a helpful AI agent running inside an event-driven system. Messages arrive from various sources (Slack, email, etc.) as events on your stream. You can execute JavaScript to interact with the world.

Write a fenced code block with the \`js\` tag to execute code. The code runs in a sandbox with these tool namespaces as globals:

${toolList}

Example — replying to a Slack message:
\`\`\`js
async () => {
  // Use channel and threadTs from the message details JSON
  const result = await slack.replyToThread({ channel: "C...", threadTs: "1234567890.123456", text: "Hello!" });
  return result;
}
\`\`\`

Example — reacting to a Slack message:
\`\`\`js
async () => {
  // Use channel and messageTs from the message details JSON
  await slack.reactToMessage({ channel: "C...", messageTs: "1234567890.123456", emoji: "eyes" });
  return { ok: true };
}
\`\`\`

Example — querying a database:
\`\`\`js
async () => {
  const things = await tanstack_app.list();
  return things;
}
\`\`\`

IMPORTANT:
- When you receive a Slack message, respond by calling slack.replyToThread() with channel and threadTs from the message details.
- Use the EXACT channel, threadTs, and messageTs values from the message details — do not guess or transform them.
- Call replyToThread ONCE. Do NOT call it again in follow-up code blocks — the first call is sufficient.
- Code blocks are auto-executed and results are fed back to you.
- Use EXACT tool names shown above. Keep prose concise.`;
}

// ── Minimal OpenAPI → tool provider ──────────────────────────────────────────
// Fetches an OpenAPI spec and creates a { name, fns } provider where each
// operation becomes an async function that calls the API via fetch.

async function createOpenApiProvider(
  name: string,
  specUrl: string,
  baseUrl: string,
): Promise<{ name: string; fns: Record<string, (...args: any[]) => Promise<any>> }> {
  const specResp = await fetch(specUrl);
  const spec = (await specResp.json()) as any;
  const fns: Record<string, (...args: any[]) => Promise<any>> = {};

  for (const [path, pathItem] of Object.entries(spec.paths ?? ({} as Record<string, any>))) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = (pathItem as any)?.[method];
      if (!op?.operationId) continue;
      const toolName = op.operationId.replace(/[^a-zA-Z0-9_]/g, "_");
      const parameters = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];

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

  return { name, fns };
}

// MCP servers registered via Agent SDK's this.addMcpServer()
const MCP_SERVERS = [
  { name: "cloudflare_docs", url: "https://docs.mcp.cloudflare.com/mcp" },
  { name: "canuckduck", url: "https://mcp.canuckduck.ca/mcp" },
] as const;

export class StreamProcessor extends Agent {
  #openApiProviders: Array<{
    name: string;
    fns: Record<string, (...args: any[]) => Promise<any>>;
  }> = [];

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
      const slug = (this.ctx.storage.kv.get("projectSlug") as string) || "test";
      for (const [name, appName] of [
        ["tanstack_app", "tanstack-app"],
        ["slack", "slack"],
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
    return this.ctx.storage.sql
      .exec("SELECT role, content FROM events WHERE role IS NOT NULL ORDER BY id")
      .toArray() as any;
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

  // Parse ```js ... ``` code blocks from AI response
  extractCodeBlocks(text: string): string[] {
    const blocks: string[] = [];
    const re = /```(?:js|javascript)\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = m[1].trim();
      if (code.length > 0) blocks.push(code);
    }
    return blocks;
  }

  async callAI(messages: Array<{ role: string; content: string }>): Promise<string | null> {
    const ai = (this as any).env.AI;
    console.log("[Agent] AI binding type:", typeof ai, "hasRun:", typeof ai?.run);
    if (!ai || typeof ai.run !== "function") {
      const err = "AI binding missing or no .run(): " + typeof ai;
      this.storeEvent("agent-error", null, null, { error: err });
      return null;
    }
    try {
      const data = await ai.run(AGENT_MODEL, { messages, max_tokens: 2048 });
      // Workers AI: some models return { response } (Llama), others return
      // { choices: [{message: {content}}] } (Kimi, OpenAI-compat). Handle both.
      const text = (data as any)?.response ?? (data as any)?.choices?.[0]?.message?.content ?? null;
      if (!text) return null;
      return String(text);
    } catch (err: any) {
      this.storeEvent("agent-error", null, null, {
        error: err.message,
        stack: err.stack?.split("\n").slice(0, 3),
      });
      return null;
    }
  }

  // Build tool providers — closures that close over this DO's bindings.
  // When passed to CodeExecutor via RPC, these become RPC stubs.
  // DynamicWorkerExecutor wraps them in ToolDispatchers.
  // Sandbox calls go: Isolate 3 → ToolDispatcher (Isolate 1) → RPC stub → here (Isolate 2)
  async buildProviders(): Promise<
    Array<{ name: string; fns: Record<string, (...args: any[]) => Promise<any>> }>
  > {
    const ai = (this as any).env.AI;
    const providers: Array<{
      name: string;
      fns: Record<string, (...args: any[]) => Promise<any>>;
    }> = [
      // Canary + debug tools
      {
        name: "builtin",
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
      // AI tool — lets codemode scripts call Workers AI
      {
        name: "ai",
        fns: {
          run: async (args: any) => {
            const model = args?.model || AGENT_MODEL;
            const messages = args?.messages || [
              { role: "user", content: String(args?.prompt || args) },
            ];
            const data = await ai.run(model, { messages, max_tokens: args?.max_tokens || 1024 });
            return (data as any)?.response ?? (data as any)?.choices?.[0]?.message?.content ?? data;
          },
        },
      },
    ];

    // OpenAPI tool providers from sibling apps
    const slug = (this.ctx.storage.kv.get("projectSlug") as string) || "test";
    for (const [name, appName] of [
      ["tanstack_app", "tanstack-app"],
      ["slack", "slack"],
    ] as const) {
      try {
        const base = appUrl(appName, slug) + "/api";
        const p = await createOpenApiProvider(name, base + "/openapi.json", base);
        providers.push(p);
      } catch (e: any) {
        console.error(`[OpenAPI] ${name} failed:`, e.message);
      }
    }

    // MCP tool providers — onStart registers servers, wait for handshakes to complete
    try {
      await this.mcp.waitForConnections({ timeout: 15_000 });
      const servers = this.mcp.listServers();
      const tools = this.mcp.listTools();
      const toolsByServer = new Map<string, any[]>();
      for (const tool of tools) {
        const list = toolsByServer.get(tool.serverId) ?? [];
        list.push(tool);
        toolsByServer.set(tool.serverId, list);
      }
      for (const [serverId, serverTools] of toolsByServer) {
        const server = servers.find((s: any) => s.id === serverId);
        const name = (server?.name || serverId).replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
        const fns: Record<string, (...args: any[]) => Promise<any>> = {};
        for (const tool of serverTools) {
          const toolKey = tool.name.replace(/[^a-zA-Z0-9_]/g, "_");
          fns[toolKey] = async (input: any) => {
            const result = await this.mcp.callTool({
              serverId,
              name: tool.name,
              arguments: input && typeof input === "object" ? input : {},
            });
            if ("toolResult" in result) return (result as any).toolResult;
            if ((result as any).structuredContent != null) return (result as any).structuredContent;
            const texts = ((result as any).content || [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text || "");
            if (texts.length > 0) {
              const j = texts.join("\n");
              try {
                return JSON.parse(j);
              } catch {
                return j;
              }
            }
            return result;
          };
        }
        if (Object.keys(fns).length > 0) {
          providers.push({ name, fns });
          console.log("[StreamProcessor] MCP:", name, "tools:", Object.keys(fns));
        }
      }
    } catch (err: any) {
      // Store the MCP error so we can see it in the codemode result
      providers.push({
        name: "mcperr",
        fns: {
          getError: async () =>
            err.message + " | " + (err.stack || "").split("\n").slice(0, 2).join(" "),
        },
      });
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
      return await (this as any).env.EXEC.execute(script, providers);
    } catch (err: any) {
      return { error: err.message };
    }
  }

  // Agent loop that collects events (for /process endpoint)
  async runAgentLoopCollecting(collect: (evt: any) => void): Promise<void> {
    const history = this.getHistory();
    const providers = await this.buildProviders();
    const systemPrompt = buildSystemPrompt(providers);
    const messages = [{ role: "system", content: systemPrompt }, ...history];

    const response = await this.callAI(messages);
    if (!response) return;

    this.storeEvent("agent-input-added", "assistant", response, {
      role: "assistant",
      content: response,
    });
    collect({ type: "agent-input-added", payload: { role: "assistant", content: response } });

    const codeBlocks = this.extractCodeBlocks(response);
    if (codeBlocks.length === 0) return;

    for (const code of codeBlocks) {
      const result = await this.executeCode(code);
      const resultStr = JSON.stringify(result, null, 2);
      this.storeEvent("codemode-block-added", null, code, { script: code });
      this.storeEvent("codemode-result-added", null, resultStr, result);
      collect({ type: "codemode-block-added", payload: { script: code } });
      collect({ type: "codemode-result-added", payload: result });
      this.storeEvent("agent-input-added", "user", "[Code result]:\n" + resultStr, {
        role: "user",
        content: "[Code result]:\n" + resultStr,
      });
    }
  }

  // Full agent loop via WebSocket (deprecated — use /process instead)
  async runAgentLoop(ws: WebSocket): Promise<void> {
    const history = this.getHistory();
    const providers = await this.buildProviders();
    const systemPrompt = buildSystemPrompt(providers);
    const messages = [{ role: "system", content: systemPrompt }, ...history];

    console.log("[Agent] calling AI with", messages.length, "messages");
    const response = await this.callAI(messages);
    if (!response) return;

    // Store and send the assistant response
    this.storeEvent("agent-input-added", "assistant", response, {
      role: "assistant",
      content: response,
    });
    ws.send(
      JSON.stringify({
        type: "append",
        event: { type: "agent-input-added", payload: { role: "assistant", content: response } },
      }),
    );

    // Check for code blocks
    const codeBlocks = this.extractCodeBlocks(response);
    if (codeBlocks.length === 0) return;

    // Execute each code block
    let hadSideEffect = false;
    for (const code of codeBlocks) {
      console.log("[Agent] executing code block:", code.slice(0, 80));
      const result = await this.executeCode(code);
      const resultStr = JSON.stringify(result, null, 2);

      this.storeEvent("codemode-block-added", null, code, { script: code });
      this.storeEvent("codemode-result-added", null, resultStr, result);

      ws.send(
        JSON.stringify({
          type: "append",
          event: { type: "codemode-block-added", payload: { script: code } },
        }),
      );
      ws.send(
        JSON.stringify({
          type: "append",
          event: { type: "codemode-result-added", payload: result },
        }),
      );

      this.storeEvent("agent-input-added", "user", "[Code execution result]:\n" + resultStr, {
        role: "user",
        content: "[Code execution result]:\n" + resultStr,
      });
      if ((result as any)?.result?.ok === true) hadSideEffect = true;
    }

    // Skip follow-up if code already performed an action (prevents double-reply)
    if (hadSideEffect) return;

    console.log("[Agent] follow-up after code execution");
    const followUpHistory = this.getHistory();
    const followUpMessages = [{ role: "system", content: systemPrompt }, ...followUpHistory];
    const followUp = await this.callAI(followUpMessages);
    if (!followUp) return;

    this.storeEvent("agent-input-added", "assistant", followUp, {
      role: "assistant",
      content: followUp,
    });
    ws.send(
      JSON.stringify({
        type: "append",
        event: { type: "agent-input-added", payload: { role: "assistant", content: followUp } },
      }),
    );
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

      // Dedup by offset — events can be delivered twice (WebSocket + _ws-message)
      if (event.offset != null) {
        const seen = this.ctx.storage.sql
          .exec(
            "SELECT id FROM events WHERE offset = ? AND stream_path = ? LIMIT 1",
            event.offset,
            this.sp,
          )
          .toArray();
        if (seen.length > 0) {
          return Response.json({ ok: true, appends: [], deduplicated: true });
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

      if (event.type === "agent-input-added" && event.payload?.role === "user") {
        try {
          await this.runAgentLoopCollecting(collect);
        } catch (loopErr: any) {
          collect({ type: "agent-error", payload: { error: "loop:" + loopErr.message } });
        }
      }
      if (event.type === "codemode-block-added" && event.payload?.script) {
        const result = await this.executeCode(event.payload.script);
        const resultStr = JSON.stringify(result, null, 2);
        this.storeEvent("codemode-result-added", null, resultStr, result);
        collect({ type: "codemode-result-added", payload: result });

        // Store result as user message so the AI can see it
        this.storeEvent("agent-input-added", "user", "[Code result]:\n" + resultStr, {
          role: "user",
          content: "[Code result]:\n" + resultStr,
        });
      }

      return Response.json({ ok: true, appends });
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

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Diagnostic: echo back immediately to prove this method fires
    try {
      ws.send(JSON.stringify({ type: "echo", raw: String(message).slice(0, 200) }));
    } catch {}
    this.ensureTable();
    try {
      const frame = JSON.parse(message as string);

      // StreamSocketEventFrame from events.iterate.com: { type: "event", event: {...} }
      if (frame.type === "event" && frame.event) {
        const event = frame.event;
        const streamPath = this.sp;
        console.log("[StreamProcessor] event frame:", event.type, "stream:", streamPath);

        // Store the event
        this.storeEvent(
          event.type || "unknown",
          event.payload?.role || null,
          event.payload?.content || null,
          event.payload || {},
          event.offset ?? null,
        );

        // Agent loop: on user message, call AI → parse code blocks → execute → follow up
        if (event.type === "agent-input-added" && event.payload?.role === "user") {
          await this.runAgentLoop(ws);
        }

        // Direct codemode (manual, not from AI) → execute and respond
        if (event.type === "codemode-block-added" && event.payload?.script) {
          const result = await this.executeCode(event.payload.script);
          this.storeEvent("codemode-result-added", null, JSON.stringify(result), result);
          ws.send(
            JSON.stringify({
              type: "append",
              event: { type: "codemode-result-added", payload: result },
            }),
          );
        }
        return;
      }

      // StreamSocketErrorFrame
      if (frame.type === "error") {
        console.error("[StreamProcessor] error frame:", frame.message);
        return;
      }

      console.log("[StreamProcessor] unknown frame type:", frame.type);
    } catch (e: any) {
      console.error("[StreamProcessor] ws message error:", e.message, e.stack);
      try {
        ws.send(JSON.stringify({ type: "error", message: e.message }));
      } catch {}
    }
  }

  webSocketClose(ws: WebSocket) {
    console.log("[StreamProcessor] WebSocket closed");
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

  getOrCreateStream(streamPath: string) {
    const facetName = "stream:" + streamPath;

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
          frame.event.type === "https://events.iterate.com/events/stream/child-stream-created" &&
          frame.event.payload?.childPath
        ) {
          const childPath = frame.event.payload.childPath as string;
          console.log("[Agents] child-stream-created (via _ws-message):", childPath);
          this.autoSubscribeChild(childPath).catch((e: any) =>
            console.error("[Agents] autoSubscribeChild error:", e.message),
          );
        }

        const proc = this.getOrCreateStream(wsStreamPath);
        const resp = await proc.fetch(
          this.facetRequest("stream:" + wsStreamPath, "http://localhost/process", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(frame.event),
          }),
        );
        return new Response(resp.body, resp);
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

      const facetName = "stream:" + streamPath;

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
            type: "https://events.iterate.com/events/stream/subscription/configured",
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

    // ── GET /api/stream-events/:streamPath — events from a stream processor ──
    const streamEventsMatch = pathname.match(/^\/api\/stream-events\/(.+)$/);
    if (req.method === "GET" && streamEventsMatch) {
      const streamPath = decodeURIComponent(streamEventsMatch[1]);
      const proc = this.getOrCreateStream(streamPath);
      return proc.fetch(this.facetRequest("stream:" + streamPath, "http://localhost/api/events"));
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
            type: "https://events.iterate.com/events/stream/subscription/configured",
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
          type: "https://events.iterate.com/events/stream/subscription/configured",
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
