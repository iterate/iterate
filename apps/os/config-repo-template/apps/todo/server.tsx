import { DurableObject } from "cloudflare:workers";

/**
 * Page-only half of the todo app. The LiveState host lives in host.ts
 * (createWorker); /api is routed there by worker.ts. This class only serves
 * the HTML shell so createApp can compile client.tsx.
 */
export class TodoPage extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
    <script type="module" src="/apps/todo/client.js"></script>
  </body>
</html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
