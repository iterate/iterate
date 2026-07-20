import { DurableObject } from "cloudflare:workers";

export class GuestbookApp extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        signed_at TEXT NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/entries") {
      if (request.method === "GET") {
        const entries = this.ctx.storage.sql
          .exec<{ id: string; message: string; name: string; signed_at: string }>(
            "SELECT id, name, message, signed_at FROM entries ORDER BY signed_at DESC, id DESC LIMIT 100",
          )
          .toArray()
          .map((entry) => ({
            id: entry.id,
            message: entry.message,
            name: entry.name,
            signedAt: entry.signed_at,
          }));
        return Response.json(entries);
      }
      if (request.method === "POST") {
        const body = await request.json<{ message?: unknown; name?: unknown }>();
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
        const message = typeof body.message === "string" ? body.message.trim().slice(0, 500) : "";
        if (name.length === 0 || message.length === 0) {
          return new Response("name and message are required", { status: 400 });
        }
        const entry = {
          id: crypto.randomUUID(),
          message,
          name,
          signedAt: new Date().toISOString(),
        };
        this.ctx.storage.sql.exec(
          "INSERT INTO entries (id, name, message, signed_at) VALUES (?, ?, ?, ?)",
          entry.id,
          entry.name,
          entry.message,
          entry.signedAt,
        );
        return Response.json(entry, { status: 201 });
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
    <title>Guestbook</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 2rem; }
      main { margin: 0 auto; max-width: 38rem; }
      form { display: grid; gap: .75rem; }
      input, textarea, button { font: inherit; padding: .6rem; }
      article { border-block-start: 1px solid #8886; margin-block-start: 1.25rem; padding-block-start: 1rem; }
      time { opacity: .65; }
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
