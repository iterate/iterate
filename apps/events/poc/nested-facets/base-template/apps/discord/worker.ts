import { DurableObject } from "cloudflare:workers";

const DISCORD_API = "https://discord.com/api/v10";
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 15);

function getPathname(urlStr: string): string {
  const afterProto = urlStr.replace(/^https?:\/\//, "");
  const slashIdx = afterProto.indexOf("/");
  if (slashIdx === -1) return "/";
  const qIdx = afterProto.indexOf("?", slashIdx);
  return qIdx === -1 ? afterProto.slice(slashIdx) : afterProto.slice(slashIdx, qIdx);
}

function formatMessageForAgent(d: any): string {
  return [
    "You received a Discord message.",
    `From: ${d.author?.username || "unknown"}`,
    `Channel: ${d.channel_id}`,
    `Message: ${d.content}`,
    "",
    "To reply, call discord.sendMessage with:",
    `  channelId: "${d.channel_id}"`,
    `  replyToMessageId: "${d.id}"`,
  ].join("\n");
}

class DiscordClient {
  constructor(
    private token: string,
    private apiBase: string,
  ) {}

  sendMessage(channelId: string, content: string, replyTo?: string) {
    return this.#call("POST", `/channels/${channelId}/messages`, {
      content,
      ...(replyTo ? { message_reference: { message_id: replyTo } } : {}),
    });
  }

  addReaction(channelId: string, messageId: string, emoji: string) {
    return this.#call(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  getGatewayUrl(): Promise<{ url: string }> {
    return this.#call("GET", "/gateway/bot") as Promise<{ url: string }>;
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const resp = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        ...(body && method !== "PUT" && method !== "GET"
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(body && method !== "PUT" && method !== "GET" ? { body: JSON.stringify(body) } : {}),
    });
    if (resp.status === 204) return { ok: true };
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { error: raw.slice(0, 200) };
    }
  }
}

export class App extends DurableObject {
  #discord: DiscordClient | null = null;
  #gatewayWs: WebSocket | null = null;
  #sessionId: string | null = null;
  #sequence: number | null = null;
  #heartbeatMs = 41_250;
  #nextHeartbeatAt = 0;
  #botUserId: string | null = null;
  #lastAck = true;
  #gatewayReadyResolver: (() => void) | null = null;

  #ensureTables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  #config(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = ?", key).toArray();
    return rows.length ? (rows[0].value as string) : null;
  }

  #setConfig(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  #client(): DiscordClient {
    if (this.#discord) return this.#discord;
    const token = this.#config("discordBotToken");
    if (!token) throw new Error("No Discord token - run /api/install");
    this.#discord = new DiscordClient(token, this.#config("discordApiBase") || DISCORD_API);
    return this.#discord;
  }

  async #appendToStream(path: string, event: unknown) {
    const eventsBase = this.#config("eventsBaseUrl");
    const slug = this.#config("projectSlug");
    if (!eventsBase || !slug) throw new Error("Not installed");
    const base = eventsBase.replace(/\/+$/, "").replace("://", `://${slug}.`);
    await fetch(`${base}/api/streams/${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
  }

  async #routeToAgent(d: any) {
    const agentPath = `/agents/discord/channel-${d.channel_id}`;
    const dedupKey = `seen:${d.id}`;
    if (
      this.ctx.storage.sql.exec("SELECT 1 FROM config WHERE key = ?", dedupKey).toArray().length
    ) {
      return;
    }
    this.#setConfig(dedupKey, "1");

    const agentEvent = {
      type: "agent-input-added",
      payload: { role: "user", content: formatMessageForAgent(d), source: "discord" },
      idempotencyKey: `agent-input:${d.id}`,
    };

    try {
      await this.#appendToStream(agentPath, agentEvent);
    } catch (e: any) {
      console.error(`[Discord] stream append failed: ${e.message}`);
    }

    const host = this.#config("hostHeader") || "";
    const agentsHost = host.replace(/^discord\./, "agents.");
    try {
      await fetch(`https://${agentsHost}/streams/${encodeURIComponent(agentPath)}/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agentEvent),
      });
    } catch (e: any) {
      console.error(`[Discord] agent trigger failed: ${e.message}`);
    }
  }

  async #connectGateway() {
    if (this.#gatewayWs?.readyState === WebSocket.OPEN) return;
    const token = this.#config("discordBotToken");
    if (!token) return;

    const gateway = await this.#client().getGatewayUrl();
    if (!gateway.url) throw new Error("No Discord gateway URL");

    const ws = new WebSocket(`${gateway.url}?v=10&encoding=json`);
    this.#gatewayWs = ws;
    this.#lastAck = true;
    ws.addEventListener("message", (evt) => this.#onGatewayMsg(String(evt.data)));
    ws.addEventListener("close", (event) => {
      this.#gatewayWs = null;
      this.#setConfig("gatewayConnected", "0");
      this.#setConfig(
        "gatewayLastClose",
        JSON.stringify({ code: event.code, reason: event.reason, wasClean: event.wasClean }),
      );
      this.#resolveGatewayReady();
    });
    ws.addEventListener("error", () => {
      this.#gatewayWs = null;
      this.#setConfig("gatewayConnected", "0");
      this.#setConfig("gatewayLastError", new Date().toISOString());
      this.#resolveGatewayReady();
    });
    await new Promise<void>((resolve) => {
      this.#gatewayReadyResolver = resolve;
    });
  }

  #resolveGatewayReady() {
    this.#gatewayReadyResolver?.();
    this.#gatewayReadyResolver = null;
  }

  #onGatewayMsg(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.s != null) this.#sequence = msg.s;
    switch (msg.op) {
      case OP.HELLO:
        this.#heartbeatMs = msg.d.heartbeat_interval;
        this.#nextHeartbeatAt = Date.now() + Math.floor(this.#heartbeatMs * Math.random());
        this.#gatewaySend({
          op: OP.IDENTIFY,
          d: {
            token: this.#config("discordBotToken"),
            intents: INTENTS,
            properties: { os: "cloudflare", browser: "iterate", device: "iterate" },
          },
        });
        break;
      case OP.DISPATCH:
        if (msg.t === "READY") {
          this.#sessionId = msg.d.session_id;
          this.#botUserId = msg.d.user?.id || null;
          this.#setConfig("gatewayConnected", "1");
          this.#resolveGatewayReady();
        }
        if (
          msg.t === "MESSAGE_CREATE" &&
          msg.d?.content &&
          !msg.d.author?.bot &&
          msg.d.author?.id !== this.#botUserId &&
          this.#botUserId &&
          Array.isArray(msg.d.mentions) &&
          msg.d.mentions.some((user: any) => user?.id === this.#botUserId)
        ) {
          this.#routeToAgent(msg.d).catch((e: any) =>
            console.error("[Discord] route error:", e.message),
          );
        }
        break;
      case OP.HEARTBEAT:
        this.#gatewaySend({ op: OP.HEARTBEAT, d: this.#sequence });
        break;
      case OP.HEARTBEAT_ACK:
        this.#lastAck = true;
        break;
      case OP.RECONNECT:
        this.#gatewayWs?.close(4000, "reconnect");
        break;
      case OP.INVALID_SESSION:
        this.#gatewayWs?.close(4000, "invalid session");
        break;
    }
  }

  #gatewaySend(data: unknown) {
    this.#gatewayWs?.send(JSON.stringify(data));
  }

  async #maintainGateway() {
    if (!this.#gatewayWs || this.#gatewayWs.readyState !== WebSocket.OPEN) {
      await this.#connectGateway();
      return;
    }

    const now = Date.now();
    if (this.#nextHeartbeatAt !== 0 && now < this.#nextHeartbeatAt) return;
    if (!this.#lastAck) {
      this.#gatewayWs.close(4000, "heartbeat timeout");
      return;
    }
    this.#lastAck = false;
    this.#gatewaySend({ op: OP.HEARTBEAT, d: this.#sequence });
    this.#nextHeartbeatAt = now + this.#heartbeatMs;
  }

  async fetch(req: Request): Promise<Response> {
    this.#ensureTables();
    const path = getPathname(req.url);

    if (path === "/api/install") return this.#install(req);
    if (path === "/api/config") {
      return Response.json(this.ctx.storage.sql.exec("SELECT * FROM config").toArray());
    }
    if (path === "/api/gateway-status") {
      return Response.json({
        connected: this.#gatewayWs?.readyState === WebSocket.OPEN,
        sessionId: this.#sessionId,
        botUserId: this.#botUserId,
        sequence: this.#sequence,
        nextHeartbeatAt: this.#nextHeartbeatAt || null,
        lastClose: this.#config("gatewayLastClose"),
        lastError: this.#config("gatewayLastError"),
      });
    }
    if (path === "/api/connect" && req.method === "POST") {
      await this.#maintainGateway();
      return Response.json({
        ok: true,
        connected: this.#gatewayWs?.readyState === WebSocket.OPEN,
        sessionId: this.#sessionId,
        botUserId: this.#botUserId,
        sequence: this.#sequence,
        nextHeartbeatAt: this.#nextHeartbeatAt || null,
        lastClose: this.#config("gatewayLastClose"),
        lastError: this.#config("gatewayLastError"),
      });
    }
    if (path === "/api/openapi.json") return Response.json(this.#openapi(req));
    if (path === "/api/docs") {
      return new Response("Discord App API - see /api/openapi.json", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (path === "/api/rpc/sendMessage" && req.method === "POST") {
      const body = (await req.json()) as any;
      return Response.json(
        await this.#client().sendMessage(body.channelId, body.content, body.replyToMessageId),
      );
    }
    if (path === "/api/rpc/addReaction" && req.method === "POST") {
      const body = (await req.json()) as any;
      return Response.json(
        await this.#client().addReaction(body.channelId, body.messageId, body.emoji),
      );
    }

    return new Response("Discord App - /api/install to set up, /api/docs for API reference");
  }

  async #install(req: Request): Promise<Response> {
    const host = req.headers.get("host") || "localhost";
    const params: Record<string, string> = {};
    const qIdx = req.url.indexOf("?");
    if (qIdx !== -1) {
      for (const p of req.url.slice(qIdx + 1).split("&")) {
        const [k, v] = p.split("=");
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    }
    if (req.method === "POST") {
      try {
        Object.assign(params, await req.json());
      } catch {}
    }

    const projectSlug = params.projectSlug || this.#config("projectSlug") || "";
    if (!projectSlug) return Response.json({ error: "projectSlug required" }, { status: 400 });

    this.#setConfig(
      "eventsBaseUrl",
      params.eventsBaseUrl || this.#config("eventsBaseUrl") || "https://events.iterate.com",
    );
    this.#setConfig("projectSlug", projectSlug);
    this.#setConfig("hostHeader", host);
    if (params.discordApiBase) this.#setConfig("discordApiBase", params.discordApiBase);
    if (params.discordBotToken) {
      this.#setConfig("discordBotToken", params.discordBotToken);
      this.#discord = null;
      this.#connectGateway().catch((e: any) => console.error("[Discord] auto-connect:", e.message));
    }

    return Response.json({
      ok: true,
      gatewayStatus: `https://${host}/api/gateway-status`,
      docs: `https://${host}/api/docs`,
    });
  }

  #openapi(req: Request) {
    const url = new URL(req.url);
    return {
      openapi: "3.1.0",
      servers: [{ url: `${url.origin}/api` }],
      info: {
        title: "Discord App API",
        version: "1.0.0",
        description: "Discord tools for agents. Send messages and react.",
      },
      paths: {
        "/rpc/sendMessage": {
          post: {
            operationId: "sendMessage",
            tags: ["discord"],
            description: "Send a message to a Discord channel.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["channelId", "content"],
                    properties: {
                      channelId: { type: "string", description: "Discord channel ID" },
                      content: { type: "string", description: "Message content" },
                      replyToMessageId: { type: "string", description: "Message ID to reply to" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "Discord message response" } },
          },
        },
        "/rpc/addReaction": {
          post: {
            operationId: "addReaction",
            tags: ["discord"],
            description: "React to a Discord message with an emoji.",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["channelId", "messageId", "emoji"],
                    properties: {
                      channelId: { type: "string", description: "Discord channel ID" },
                      messageId: { type: "string", description: "Discord message ID" },
                      emoji: { type: "string", description: "Emoji, unicode or custom name:id" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "Discord reaction response" } },
          },
        },
      },
    };
  }
}
