import { IterateDurableObject } from "iterate/sdk";

// A stateful app: a Durable Object hosted as a repo-backed stateful dynamic
// worker. State survives across requests under its durableWorkerKey, and
// every open page gets live updates over a WebSocket. The /ws upgrade's 101
// response reaches this Durable Object over the platform's fetch-native
// worker lane (the ProjectWorker router, via `fetchDynamicWorker`) —
// an `app.fetch(req)` RPC method call could not carry a socket. Copy this
// shape for anything real-time.
export class CounterApp extends IterateDurableObject {
  private sockets = new Set<WebSocket>();

  async fetch(req: Request): Promise<Response> {
    // The path lane advertises its stripped URL prefix; host lanes have none.
    const prefix = req.headers.get("x-iterate-url-prefix") ?? "";
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const ws = pair[1];
      ws.accept();
      this.sockets.add(ws);
      const drop = () => this.sockets.delete(ws);
      ws.addEventListener("close", drop);
      ws.addEventListener("error", drop);
      // Greet every new socket with the current count, so a fresh tab is
      // correct before anyone clicks.
      ws.send(String(await this.current()));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (req.method === "POST" && url.pathname === "/increment") {
      return Response.json({ count: await this.increment() });
    }

    // A mini client-side app: the count renders server-side, the button
    // POSTs /increment, and the WebSocket pushes every new value to every
    // open tab. The button stays disabled — with a visible "connecting…"
    // state — until the socket is open, so a click always has a live update
    // lane and anyone (tests included) can SEE why the button isn't ready
    // yet.
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>count: <span id="n">${await this.current()}</span></p>
              <button id="b" disabled>increment</button>
              <p id="s" aria-live="polite">connecting…</p>
            </main>
            <script>
              const button = document.getElementById("b");
              const status = document.getElementById("s");
              button.onclick = async () => {
                button.disabled = true;
                status.hidden = false;
                status.textContent = "incrementing…";
                try {
                  const response = await fetch("${prefix}/increment", { method: "POST" });
                  if (!response.ok) throw new Error("increment failed (" + response.status + ")");
                } catch (error) {
                  status.textContent = "increment failed";
                  button.disabled = false;
                  console.error(error);
                }
              };
              const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "${prefix}/ws");
              ws.onopen = () => { button.disabled = false; status.hidden = true; };
              ws.onmessage = (event) => {
                document.getElementById("n").textContent = event.data;
                button.disabled = false;
                status.hidden = true;
              };
            </script>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  async increment(): Promise<number> {
    const n = (this.ctx.storage.kv.get<number>("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    for (const ws of this.sockets) ws.send(String(n));
    return n;
  }

  async current(): Promise<number> {
    return this.ctx.storage.kv.get<number>("n") ?? 0;
  }
}
