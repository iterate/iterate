import { DurableObject } from "cloudflare:workers";

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

const SYSTEM_PROMPT = `You are a helpful coding assistant running inside a Cloudflare Worker.

You can execute JavaScript code by wrapping it in a fenced code block with the language tag "js". The code must be an async arrow function that receives {ai, model} and returns a value:

\`\`\`js
async ({ai, model}) => {
  // ai.run(model, {messages, max_tokens}) calls Workers AI
  const r = await ai.run(model, {
    messages: [{role: "user", content: "What is 2+2?"}],
    max_tokens: 50,
  });
  return { answer: r.response };
}
\`\`\`

The result of the code execution will be provided back to you. Use code blocks when the user asks you to compute something, fetch data, or do anything that benefits from actual execution rather than just reasoning.

Keep non-code responses concise. When you use a code block, briefly explain what you're doing before and after.`;

export class StreamProcessor extends DurableObject {
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

  async executeCode(script: string): Promise<{ result?: unknown; error?: string }> {
    try {
      return await (this as any).env.EXEC.execute(script);
    } catch (err: any) {
      return { error: err.message };
    }
  }

  // Agent loop that collects events (for /process endpoint)
  async runAgentLoopCollecting(collect: (evt: any) => void): Promise<void> {
    const history = this.getHistory();
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

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

    const followUp = await this.callAI([
      { role: "system", content: SYSTEM_PROMPT },
      ...this.getHistory(),
    ]);
    if (!followUp) return;
    this.storeEvent("agent-input-added", "assistant", followUp, {
      role: "assistant",
      content: followUp,
    });
    collect({ type: "agent-input-added", payload: { role: "assistant", content: followUp } });
  }

  // Full agent loop via WebSocket (deprecated — use /process instead)
  async runAgentLoop(ws: WebSocket): Promise<void> {
    const history = this.getHistory();
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

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
    for (const code of codeBlocks) {
      console.log("[Agent] executing code block:", code.slice(0, 80));
      const result = await this.executeCode(code);
      const resultStr = JSON.stringify(result, null, 2);

      // Store the codemode events
      this.storeEvent("codemode-block-added", null, code, { script: code });
      this.storeEvent("codemode-result-added", null, resultStr, result);

      // Append to stream
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

      // Add result to history as a "system" message so AI sees it
      this.storeEvent("agent-input-added", "user", "[Code execution result]:\n" + resultStr, {
        role: "user",
        content: "[Code execution result]:\n" + resultStr,
      });
    }

    // Follow-up: let AI see the code results and provide a final response
    console.log("[Agent] follow-up after code execution");
    const followUpHistory = this.getHistory();
    const followUpMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...followUpHistory];
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

  async fetch(req: Request): Promise<Response> {
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

    // POST /process — process an event, return append events
    if (req.method === "POST" && pathname === "/process") {
      const event = (await req.json()) as any;
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
        this.storeEvent("codemode-result-added", null, JSON.stringify(result), result);
        collect({ type: "codemode-result-added", payload: result });
      }

      return Response.json({ ok: true, appends });
    }

    // POST /init — set stream path
    if (req.method === "POST" && pathname === "/init") {
      const body = (await req.json()) as any;
      if (body._setStreamPath) {
        this.ctx.storage.kv.put("streamPath", body._setStreamPath);
      }
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
  }

  getOrCreateStream(streamPath: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO _facets (name, class_name) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_fetch_at = datetime('now')",
      "stream:" + streamPath,
      "StreamProcessor",
    );

    const proc = this.ctx.facets.get("stream:" + streamPath, async () => {
      return { class: (this.ctx as any).exports.StreamProcessor };
    });

    proc
      .fetch(
        new Request("http://localhost/init", {
          method: "POST",
          body: JSON.stringify({ _setStreamPath: streamPath }),
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

        const proc = this.getOrCreateStream(wsStreamPath);
        const resp = await proc.fetch(
          new Request("http://localhost/process", {
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

      // WebSocket upgrade — accept at App DO (nested facets can't do WebSocket)
      // Tag with stream path so webSocketMessage can dispatch
      if (req.headers.get("Upgrade") === "websocket") {
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], ["stream:" + streamPath]);
        pair[1].send(JSON.stringify({ type: "connected", stream: streamPath }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      // /_studio + /_sql
      if (subPath === "/_studio") {
        return proc.fetch(new Request("http://localhost/_studio"));
      }
      if (req.method === "POST" && subPath === "/_sql") {
        return proc.fetch(
          new Request("http://localhost/_sql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: req.body,
          }),
        );
      }

      // Forward other requests
      return proc.fetch(
        new Request("http://localhost" + subPath, {
          method: req.method,
          headers: req.headers,
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

      // Construct events project API URL
      // "https://events.iterate.com" → "https://test.events.iterate.com/api"
      const base = body.eventsBaseUrl.replace(/\/+$/, "");
      const projectApiBase =
        body.eventsProjectSlug === "public"
          ? base + "/api"
          : base.replace("://", "://" + body.eventsProjectSlug + ".") + "/api";

      // Append subscription event to events.iterate.com
      const appendUrl = projectApiBase + "/streams/" + encodeURIComponent(streamPath);
      console.log("[App] subscribing:", appendUrl, "callback:", callbackUrl);

      let appendResult: any = null;
      let appendError: string | null = null;
      try {
        const appendResp = await fetch(appendUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: {
              type: "https://events.iterate.com/events/stream/subscription/configured",
              payload: { slug, type: "websocket", callbackUrl },
            },
          }),
        });
        appendResult = await appendResp.json();
        if (!appendResp.ok) {
          appendError = `HTTP ${appendResp.status}: ${JSON.stringify(appendResult)}`;
        }
      } catch (e: any) {
        appendError = e.message;
      }

      // Broadcast to UI
      this.broadcastSync();

      return Response.json({ ok: !appendError, slug, callbackUrl, appendResult, appendError });
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
      return proc.fetch(new Request("http://localhost/api/events"));
    }

    // For anything else, return 404 — the Project DO serves the SPA from dist assets
    return new Response("Not found", { status: 404 });
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

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Dispatch stream WebSocket messages to the StreamProcessor via /process
    const tags = this.ctx.getTags(ws);
    const streamTag = tags.find((t: string) => t.startsWith("stream:"));
    if (!streamTag) return;
    const streamPath = streamTag.slice("stream:".length);

    try {
      const frame = JSON.parse(message as string);
      if (frame.type !== "event" || !frame.event) return;

      const proc = this.getOrCreateStream(streamPath);
      const resp = await proc.fetch(
        new Request("http://localhost/process", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frame.event),
        }),
      );
      const result = (await resp.json()) as any;

      // Forward any append events back through the WebSocket
      if (result.appends) {
        for (const appendEvent of result.appends) {
          ws.send(JSON.stringify({ type: "append", event: appendEvent }));
        }
      }
    } catch (e: any) {
      console.error("[App] ws dispatch error:", e.message);
      try {
        ws.send(JSON.stringify({ type: "error", message: e.message }));
      } catch {}
    }
  }
  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
