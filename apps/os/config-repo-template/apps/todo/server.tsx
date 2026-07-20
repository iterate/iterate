import { DurableObject } from "cloudflare:workers";

export class TodoApp extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/todos") {
      if (request.method === "GET") {
        const todos = this.ctx.storage.sql
          .exec<{ created_at: string; done: number; id: string; title: string }>(
            "SELECT id, title, done, created_at FROM todos ORDER BY created_at, id",
          )
          .toArray()
          .map((todo) => ({
            createdAt: todo.created_at,
            done: todo.done !== 0,
            id: todo.id,
            title: todo.title,
          }));
        return Response.json(todos);
      }
      if (request.method === "POST") {
        const body = await request.json<{ title?: unknown }>();
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
        if (title.length === 0) return new Response("title is required", { status: 400 });
        const todo = {
          createdAt: new Date().toISOString(),
          done: false,
          id: crypto.randomUUID(),
          title,
        };
        this.ctx.storage.sql.exec(
          "INSERT INTO todos (id, title, done, created_at) VALUES (?, ?, 0, ?)",
          todo.id,
          todo.title,
          todo.createdAt,
        );
        return Response.json(todo, { status: 201 });
      }
      return new Response("method not allowed", { status: 405 });
    }

    const match = /^\/api\/todos\/([^/]+)$/.exec(url.pathname);
    if (match !== null) {
      const id = match[1] ?? "";
      if (request.method === "PATCH") {
        const body = await request.json<{ done?: unknown }>();
        if (typeof body.done !== "boolean") {
          return new Response("done must be a boolean", { status: 400 });
        }
        this.ctx.storage.sql.exec("UPDATE todos SET done = ? WHERE id = ?", body.done ? 1 : 0, id);
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        this.ctx.storage.sql.exec("DELETE FROM todos WHERE id = ?", id);
        return new Response(null, { status: 204 });
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Todo</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 2rem; }
      main { margin: 0 auto; max-width: 38rem; }
      form, li { display: flex; gap: .75rem; margin-block: .75rem; }
      input[type="text"] { flex: 1; padding: .6rem; }
      button { padding: .45rem .75rem; }
      .done { text-decoration: line-through; opacity: .65; }
      [role="alert"] { color: #c33; }
    </style>
  </head>
  <body>
    <main id="root"><p>Loading…</p></main>
    <script type="module" src="/client.js"></script>
  </body>
</html>`,
      {
        headers: {
          "content-security-policy":
            "default-src 'self'; script-src 'self' https://esm.sh; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
