import { DurableObject } from "cloudflare:workers";

// A stateful app: a Durable Object class hosted as a repo-backed stateful
// dynamic worker. State survives across requests under its durableWorkerKey.
export class CounterApp extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    // The path lane advertises its stripped URL prefix; host lanes have none.
    const prefix = req.headers.get("x-iterate-url-prefix") ?? "";
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/increment") {
      await this.increment();
      // Redirect back so the browser URL never sticks at /increment.
      return new Response(null, { status: 303, headers: { location: `${prefix}/` } });
    }

    const count = await this.current();
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>count: ${count}</p>
              <form method="post" action="${prefix}/increment">
                <button type="submit">increment</button>
              </form>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  async increment(): Promise<number> {
    const n = (this.ctx.storage.kv.get<number>("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return n;
  }

  async current(): Promise<number> {
    return this.ctx.storage.kv.get<number>("n") ?? 0;
  }
}
