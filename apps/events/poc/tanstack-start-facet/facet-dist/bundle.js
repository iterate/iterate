import handler from "./server-entry.js";

export class App {
  #sql;

  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.#sql = state.storage.sql;
    // Ensure things table exists
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS things (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── API routes: handled by the DO with SQLite ──
    if (url.pathname === "/api/things" && request.method === "GET") {
      const rows = this.#sql
        .exec("SELECT id, name, created_at as createdAt FROM things ORDER BY created_at DESC")
        .toArray();
      return Response.json(rows);
    }

    if (url.pathname === "/api/things" && request.method === "POST") {
      const body = await request.json();
      const name = body.name?.trim();
      if (!name) return Response.json({ error: "name required" }, { status: 400 });
      const id = "thing_" + crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      this.#sql.exec("INSERT INTO things (id, name, created_at) VALUES (?, ?, ?)", id, name, now);
      return Response.json({ id, name, createdAt: now }, { status: 201 });
    }

    const deleteMatch = url.pathname.match(/^\/api\/things\/(.+)$/);
    if (deleteMatch && request.method === "DELETE") {
      const id = deleteMatch[1];
      this.#sql.exec("DELETE FROM things WHERE id = ?", id);
      return Response.json({ ok: true });
    }

    // ── WebSocket upgrade ──
    if (request.headers.get("Upgrade") === "websocket" && url.pathname === "/api/ws") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      server.send(JSON.stringify({ type: "connected", doId: this.state.id?.toString() }));

      // Broadcast count of things on connect
      const count = this.#sql.exec("SELECT COUNT(*) as c FROM things").toArray()[0]?.c ?? 0;
      server.send(JSON.stringify({ type: "sync", thingCount: count }));

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Everything else: TanStack Start SSR ──
    try {
      return await handler.fetch(request);
    } catch (err) {
      console.error("[TanStack Start Facet] SSR error:", err.message, err.stack);
      return new Response("Internal Server Error: " + err.message, { status: 500 });
    }
  }
}
