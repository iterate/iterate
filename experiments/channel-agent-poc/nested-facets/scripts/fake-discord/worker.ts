/**
 * Fake Discord API + Gateway server for testing the Discord app.
 *
 * REST endpoints:
 *   GET  /api/v10/gateway/bot → { url: "wss://<host>/gateway" }
 *   POST /api/v10/channels/:id/messages → logs and returns fake message
 *   PUT  /api/v10/channels/:id/messages/:mid/reactions/:emoji/@me → 204
 *   PATCH /api/v10/channels/:id/messages/:mid → logs and returns updated
 *
 * WebSocket gateway:
 *   /gateway → simulates Discord Gateway protocol
 *   Sends Hello, accepts Identify, sends Ready, can inject MESSAGE_CREATE
 *
 * Admin:
 *   POST /admin/send-message → injects a MESSAGE_CREATE event into all connected gateways
 *   GET  /admin/log → returns all REST API calls received
 */

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── WebSocket Gateway ──
    if (path === "/gateway" && req.headers.get("upgrade") === "websocket") {
      return handleGateway(req, env);
    }

    // ── Admin: inject a fake message ──
    if (path === "/admin/send-message" && req.method === "POST") {
      const body = (await req.json()) as any;
      const event = {
        op: 0,
        s: nextSeq(),
        t: "MESSAGE_CREATE",
        d: {
          id: body.messageId || String(Date.now()),
          channel_id: body.channelId || "fake-channel-001",
          guild_id: body.guildId || "fake-guild-001",
          content: body.content || "Hello from fake Discord!",
          author: {
            id: body.authorId || "fake-user-001",
            username: body.authorUsername || "testuser",
            bot: false,
          },
          timestamp: new Date().toISOString(),
        },
      };

      // Broadcast to all connected gateways via the DO
      const doId = env.GATEWAY.idFromName("singleton");
      const stub = env.GATEWAY.get(doId);
      await stub.fetch(
        new Request("http://internal/broadcast", {
          method: "POST",
          body: JSON.stringify(event),
        }),
      );

      return Response.json({ ok: true, event: event.d });
    }

    // ── Admin: view API call log ──
    if (path === "/admin/log") {
      const doId = env.GATEWAY.idFromName("singleton");
      const stub = env.GATEWAY.get(doId);
      const resp = await stub.fetch(new Request("http://internal/log"));
      return new Response(resp.body, resp);
    }

    // ── REST API: /api/v10/gateway/bot ──
    if (path === "/api/v10/gateway/bot") {
      const host = req.headers.get("host") || url.host;
      return Response.json({ url: `wss://${host}/gateway` });
    }

    // ── REST API: POST channels/:id/messages ──
    const postMsg = path.match(/^\/api\/v10\/channels\/([^/]+)\/messages$/);
    if (postMsg && req.method === "POST") {
      const channelId = postMsg[1];
      const body = (await req.json()) as any;
      const entry = { method: "POST", path, channelId, body, at: new Date().toISOString() };

      // Log it
      const doId = env.GATEWAY.idFromName("singleton");
      const stub = env.GATEWAY.get(doId);
      await stub.fetch(
        new Request("http://internal/log-entry", {
          method: "POST",
          body: JSON.stringify(entry),
        }),
      );

      console.log("[Fake Discord] POST message:", channelId, body.content?.slice(0, 80));

      return Response.json({
        id: String(Date.now()),
        channel_id: channelId,
        content: body.content || "",
        author: { id: "fake-bot-001", username: "testbot", bot: true },
        timestamp: new Date().toISOString(),
      });
    }

    // ── REST API: PUT reaction ──
    const putReaction = path.match(
      /^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\//,
    );
    if (putReaction && req.method === "PUT") {
      const entry = { method: "PUT", path, at: new Date().toISOString() };
      const doId = env.GATEWAY.idFromName("singleton");
      const stub = env.GATEWAY.get(doId);
      await stub.fetch(
        new Request("http://internal/log-entry", {
          method: "POST",
          body: JSON.stringify(entry),
        }),
      );
      return new Response(null, { status: 204 });
    }

    // ── REST API: PATCH message ──
    const patchMsg = path.match(/^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/);
    if (patchMsg && req.method === "PATCH") {
      const body = (await req.json()) as any;
      const entry = { method: "PATCH", path, body, at: new Date().toISOString() };
      const doId = env.GATEWAY.idFromName("singleton");
      const stub = env.GATEWAY.get(doId);
      await stub.fetch(
        new Request("http://internal/log-entry", {
          method: "POST",
          body: JSON.stringify(entry),
        }),
      );
      return Response.json({ id: patchMsg[2], channel_id: patchMsg[1], content: body.content });
    }

    return new Response(
      "Fake Discord Server\n\nPOST /admin/send-message to inject events\nGET /admin/log to see API calls",
      {
        headers: { "content-type": "text/plain" },
      },
    );
  },
};

let seq = 0;
function nextSeq() {
  return ++seq;
}

// ── Gateway WebSocket handler via DO ────────────────────────────────────────

async function handleGateway(req: Request, env: any): Promise<Response> {
  const doId = env.GATEWAY.idFromName("singleton");
  const stub = env.GATEWAY.get(doId);
  return stub.fetch(req);
}

export class GatewayDO {
  state: DurableObjectState;
  log: any[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal: broadcast a message to all connected WebSockets
    if (url.pathname === "/broadcast") {
      const event = await req.json();
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(JSON.stringify(event));
        } catch {}
      }
      return Response.json({ ok: true, clients: this.state.getWebSockets().length });
    }

    // Internal: log an API call
    if (url.pathname === "/log-entry" && req.method === "POST") {
      const entry = await req.json();
      this.log.push(entry);
      // Keep last 100
      if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
      return Response.json({ ok: true });
    }

    // Internal: get log
    if (url.pathname === "/log") {
      return Response.json({ log: this.log });
    }

    // WebSocket upgrade
    if (req.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = pair;

      this.state.acceptWebSocket(server);

      // Send Hello (opcode 10) with heartbeat interval
      server.send(
        JSON.stringify({
          op: 10,
          d: { heartbeat_interval: 41250 },
        }),
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("GatewayDO", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const msg = JSON.parse(String(message));

      // Handle IDENTIFY (opcode 2)
      if (msg.op === 2) {
        console.log("[Fake Gateway] IDENTIFY received");
        ws.send(
          JSON.stringify({
            op: 0,
            s: nextSeq(),
            t: "READY",
            d: {
              v: 10,
              user: { id: "fake-bot-001", username: "testbot", bot: true },
              session_id: "fake-session-" + Date.now(),
              resume_gateway_url: "wss://fake-resume.example.com",
              guilds: [],
            },
          }),
        );
        return;
      }

      // Handle HEARTBEAT (opcode 1)
      if (msg.op === 1) {
        ws.send(JSON.stringify({ op: 11, d: null }));
        return;
      }

      // Handle RESUME (opcode 6)
      if (msg.op === 6) {
        console.log("[Fake Gateway] RESUME received");
        ws.send(JSON.stringify({ op: 0, s: nextSeq(), t: "RESUMED", d: {} }));
        return;
      }

      console.log("[Fake Gateway] Unknown op:", msg.op);
    } catch (e: any) {
      console.error("[Fake Gateway] Error:", e.message);
    }
  }

  webSocketClose(ws: WebSocket) {
    console.log("[Fake Gateway] WebSocket closed");
  }
}
