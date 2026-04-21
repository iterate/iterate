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

// ── StreamProcessor — receives events from events.iterate.com via WebSocket ──
// Processes agent-input-added (user) events by calling OpenAI and appending
// the assistant response back via the same WebSocket connection.

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

  getHistory(): Array<{ role: string; content: string }> {
    return this.ctx.storage.sql
      .exec(
        "SELECT role, content FROM events WHERE type = 'agent-input-added' AND role IS NOT NULL ORDER BY id",
      )
      .toArray() as any;
  }

  async runCodemode(script: string): Promise<{ result?: unknown; error?: string }> {
    console.log("[StreamProcessor] running codemode, script length:", script.length);
    try {
      // EXEC is the CodeExecutor service binding — runs scripts in sandboxed workers
      const result = await (this as any).env.EXEC.execute(script);
      console.log("[StreamProcessor] codemode result:", JSON.stringify(result).slice(0, 200));

      // Store the result
      const sp = (this.ctx.storage.kv.get("streamPath") as string) || "unknown";
      this.ctx.storage.sql.exec(
        "INSERT INTO events (type, payload, stream_path) VALUES (?, ?, ?)",
        "codemode-result-added",
        JSON.stringify(result),
        sp,
      );

      return result;
    } catch (err: any) {
      console.error("[StreamProcessor] codemode error:", err.message);
      return { error: err.message };
    }
  }

  async runAgent(): Promise<{ role: string; content: string } | null> {
    const history = this.getHistory();
    const messages = [
      { role: "system", content: "You are a helpful assistant. Keep responses concise." },
      ...history,
    ];

    console.log("[StreamProcessor] calling Workers AI with", messages.length, "messages");

    let data: any;
    try {
      data = await (this as any).env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages,
        max_tokens: 1024,
      });
    } catch (err: any) {
      console.error("[StreamProcessor] AI error:", err.message);
      const streamPath = (this.ctx.storage.kv.get("streamPath") as string) || "unknown";
      this.ctx.storage.sql.exec(
        "INSERT INTO events (type, payload, stream_path) VALUES (?, ?, ?)",
        "agent-error",
        JSON.stringify({ error: err.message }),
        streamPath,
      );
      return null;
    }

    const assistantContent = data.response as string;

    // Store assistant response
    const streamPath = (this.ctx.storage.kv.get("streamPath") as string) || "unknown";
    this.ctx.storage.sql.exec(
      "INSERT INTO events (type, role, content, payload, stream_path) VALUES (?, ?, ?, ?, ?)",
      "agent-input-added",
      "assistant",
      assistantContent,
      JSON.stringify({ role: "assistant", content: assistantContent }),
      streamPath,
    );

    console.log("[StreamProcessor] assistant response:", assistantContent.slice(0, 80));
    return { role: "assistant", content: assistantContent };
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
      return new Response(null, { status: 101, webSocket: pair[0] });
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
    try {
      const frame = JSON.parse(message as string);

      // StreamSocketEventFrame from events.iterate.com: { type: "event", event: {...} }
      if (frame.type === "event" && frame.event) {
        const event = frame.event;
        const streamPath = (this.ctx.storage.kv.get("streamPath") as string) || "unknown";
        console.log("[StreamProcessor] event frame:", event.type, "stream:", streamPath);

        // Store the event
        this.ctx.storage.sql.exec(
          "INSERT INTO events (type, role, content, payload, offset, stream_path) VALUES (?, ?, ?, ?, ?, ?)",
          event.type || "unknown",
          event.payload?.role || null,
          event.payload?.content || null,
          JSON.stringify(event.payload || {}),
          event.offset ?? null,
          streamPath,
        );

        // Process agent-input-added (user) → call Workers AI → respond
        if (event.type === "agent-input-added" && event.payload?.role === "user") {
          const result = await this.runAgent();
          if (result) {
            ws.send(
              JSON.stringify({
                type: "append",
                event: { type: "agent-input-added", payload: result },
              }),
            );
          }
        }

        // Process codemode-block-added → execute script in sandboxed worker → respond
        if (event.type === "codemode-block-added" && event.payload?.script) {
          const codemodeResult = await this.runCodemode(event.payload.script);
          ws.send(
            JSON.stringify({
              type: "append",
              event: { type: "codemode-result-added", payload: codemodeResult },
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
      console.error("[StreamProcessor] ws message error:", e.message);
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

    // ── Streams routing: /streams/:encodedPath/... ──
    const streamsMatch = pathname.match(/^\/streams\/([^/]+)(\/.*)?$/);
    if (streamsMatch) {
      const streamPath = decodeURIComponent(streamsMatch[1]);
      const subPath = streamsMatch[2] || "/";
      const proc = this.getOrCreateStream(streamPath);

      // WebSocket upgrade → forward to StreamProcessor facet
      if (req.headers.get("Upgrade") === "websocket") {
        return proc.fetch(req);
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

  // WebSocket for streams is handled by StreamProcessor facets directly
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}
  webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
