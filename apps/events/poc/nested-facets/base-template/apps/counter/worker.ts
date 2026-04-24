import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const doId = this.ctx.id.toString();
    console.log("[CounterApp] doId=" + doId + " method=" + req.method + " path=" + url.pathname);

    // WebSocket upgrade on /api/ws
    if (req.headers.get("Upgrade") === "websocket" && url.pathname === "/api/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const count = this.ctx.storage.kv.get("count") || 0;
      pair[1].send(JSON.stringify({ type: "sync", count }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // API endpoints
    if (req.method === "POST" && url.pathname === "/api/increment") {
      const count = ((this.ctx.storage.kv.get("count") as number) || 0) + 1;
      this.ctx.storage.kv.put("count", count);
      this.broadcast(count);
      return Response.json({ count, doId });
    }

    if (req.method === "POST" && url.pathname === "/api/decrement") {
      const count = ((this.ctx.storage.kv.get("count") as number) || 0) - 1;
      this.ctx.storage.kv.put("count", count);
      this.broadcast(count);
      return Response.json({ count, doId });
    }

    if (req.method === "GET" && url.pathname === "/api/count") {
      const count = this.ctx.storage.kv.get("count") || 0;
      return Response.json({ count, doId });
    }

    // Serve client assets from R2 via env.ASSETS (if available)
    if ((this.env as any).ASSETS) {
      return (this.env as any).ASSETS.fetch(req);
    }
    return new Response("Not found", { status: 404 });
  }

  broadcast(count: number) {
    const msg = JSON.stringify({ type: "sync", count });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch (e: any) {
        console.log("[CounterApp] ws send error: " + e.message);
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message as string);
      let count = (this.ctx.storage.kv.get("count") as number) || 0;
      if (data.action === "increment") count++;
      else if (data.action === "decrement") count--;
      this.ctx.storage.kv.put("count", count);
      this.broadcast(count);
    } catch (e: any) {
      console.log("[CounterApp] ws message error: " + e.message);
    }
  }

  async webSocketClose(ws: WebSocket) {
    ws.close();
  }
}
