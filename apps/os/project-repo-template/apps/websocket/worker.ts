import { DurableObject } from "cloudflare:workers";

// The seeded WebSocket proof-of-concept: a stateful app whose Durable Object
// holds every live socket and relays messages between them. Connect to /ws,
// send a text frame, and the app echoes it back (`echo:<text>`) and forwards
// it to every other connected client (`peer:<text>`). The homepage is a tiny
// chat page exercising exactly that.
//
// All app HTTP — including the /ws upgrade below — reaches this Durable
// Object over the platform's fetch-native worker lane (see the router in the
// root worker.ts: `this.env.ITX.fetch(...)` with the app's ref in the
// x-iterate-worker-dispatch header). That lane is what lets the 101 response
// carry its socket; an `app.fetch(req)` RPC method call could not.
export class WebsocketEchoApp extends DurableObject {
  private sockets = new Set<WebSocket>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.acceptSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/health") {
      return Response.json({ connections: this.sockets.size, ok: true });
    }

    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // Named to avoid the DurableObject base class's `connect(socket)` TCP
  // handler, which this would otherwise override with the wrong signature.
  private acceptSocket(ws: WebSocket) {
    ws.accept();
    this.sockets.add(ws);

    ws.addEventListener("message", (event) => {
      const text = String(event.data ?? "");
      ws.send(`echo:${text}`);
      for (const peer of this.sockets) {
        if (peer !== ws) peer.send(`peer:${text}`);
      }
    });

    const drop = () => this.sockets.delete(ws);
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }
}

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>websocket echo</title>
</head>
<body>
  <main>
    <p>WebSocket echo: messages come back as <code>echo:</code>, other tabs see <code>peer:</code>.</p>
    <p id="status">connecting…</p>
    <form id="form"><input id="input" autocomplete="off" placeholder="say something"><button>send</button></form>
    <pre id="log"></pre>
  </main>
  <script>
    const status = document.getElementById("status");
    const log = document.getElementById("log");
    let ws;
    function connect() {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
      ws.onopen = () => { status.textContent = "connected"; };
      ws.onmessage = (event) => { log.textContent += event.data + "\\n"; };
      ws.onclose = () => { status.textContent = "reconnecting…"; setTimeout(connect, 1000); };
    }
    document.getElementById("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("input");
      if (ws && ws.readyState === WebSocket.OPEN && input.value) ws.send(input.value);
      input.value = "";
    });
    connect();
  </script>
</body>
</html>`;
