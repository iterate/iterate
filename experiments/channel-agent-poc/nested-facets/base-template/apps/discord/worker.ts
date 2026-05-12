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

const DEFAULT_EVENTS = [
  {
    type: "events.iterate.com/agent/system-prompt-updated",
    payload: {
      systemPrompt:
        "You are an Iterate Discord bot. Respond to compact Discord message notifications by writing exactly one fenced `js` codemode block containing the program body directly. Top-level `await` and `return` are valid. Do not write an `async () => { ... }` wrapper; the runtime supplies it. Use the `discord` provider only. Do not call `webchat`. Keep the block short and complete. Never write prose outside the fence. Copy channelId and messageId from the compact YAML. If you need multiple independent Discord API calls in one response, run them concurrently with `Promise.all([...])`.",
    },
  },
  {
    type: "events.iterate.com/agent/input-added",
    payload: {
      role: "user",
      content:
        "Discord policy: read the filtered `events.iterate.com/discord/websocket-message-received` YAML. Reply in Discord with `discord.sendMessage` using `event.response.sendMessage.channelId` and `event.response.sendMessage.replyToMessageId`. If reacting, use `event.response.addReaction.channelId` and `event.response.addReaction.messageId`. Do not send a separate webchat confirmation. There is no `event` global in codemode; copy exact IDs from the YAML into constants. Always return the tool promise or result. If you both reply and react, use `Promise.all([discord.sendMessage(...), discord.addReaction(...)])`.",
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  },
];

function defaultEventsText(): string {
  return JSON.stringify(DEFAULT_EVENTS, null, 2);
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = Math.imul(31, hash) + value.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function parseDefaultEvents(text: string): any[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Default events must be a JSON array");
  return parsed;
}

function defaultEventsEditorHtml(appName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${appName} default events</title><style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#f7f7f4;color:#111827}main{padding:16px;height:100vh;box-sizing:border-box;display:grid;grid-template-rows:auto 1fr auto;gap:12px}h1{font-size:16px;margin:0}textarea{width:100%;height:100%;box-sizing:border-box;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:12px;border:1px solid #d4d4d0;border-radius:6px;resize:none}button{border:1px solid #111827;background:#111827;color:white;border-radius:6px;padding:8px 12px}#status{font-size:12px;color:#4b5563}</style></head><body><main><h1>${appName} default events</h1><textarea id="events" spellcheck="false"></textarea><div><button id="save">Save</button> <span id="status"></span></div></main><script>const textarea=document.getElementById("events");const status=document.getElementById("status");async function load(){const response=await fetch("/api/default-events");const data=await response.json();textarea.value=data.eventsText||""}document.getElementById("save").addEventListener("click",async()=>{status.textContent="Saving...";const response=await fetch("/api/default-events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({eventsText:textarea.value})});const data=await response.json();status.textContent=data.ok?"Saved":data.error||"Failed"});load().catch((error)=>status.textContent=error.message);</script></body></html>`;
}

function yamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const stringValue = String(value);
  if (/^[a-zA-Z0-9._/@:-]+$/.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

function yamlKeyValue(key: string, value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (typeof value === "string" && value.includes("\n")) {
    return [`${pad}${key}: |-`, ...value.split("\n").map((line) => `${pad}  ${line}`)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    return [`${pad}${key}:`, ...yamlValue(value, indent + 2)];
  }
  if (value != null && typeof value === "object") {
    if (Object.keys(value).length === 0) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...yamlValue(value, indent + 2)];
  }
  return [`${pad}${key}: ${yamlScalar(value)}`];
}

function yamlValue(value: unknown, indent = 0): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    return value.flatMap((item) =>
      item != null && typeof item === "object"
        ? [`${pad}-`, ...yamlValue(item, indent + 2)]
        : [`${pad}- ${yamlScalar(item)}`],
    );
  }
  if (value != null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => yamlKeyValue(key, child, indent));
  }
  return [`${pad}${yamlScalar(value)}`];
}

function eventToYaml(event: unknown): string {
  return ["```yaml", ...yamlValue({ event }), "```"].join("\n");
}

function agentInputForDiscordMessage(args: {
  rawEvent: { type: string; payload?: unknown; idempotencyKey?: string };
}) {
  const payload = args.rawEvent.payload as any;
  const data = payload?.data ?? {};
  return {
    type: "events.iterate.com/agent/input-added",
    idempotencyKey: `${args.rawEvent.idempotencyKey || crypto.randomUUID()}:agent-input`,
    payload: {
      role: "user",
      source: "discord",
      content: eventToYaml({
        type: args.rawEvent.type,
        idempotencyKey: args.rawEvent.idempotencyKey,
        filtered: true,
        payload: {
          dispatchType: payload?.dispatchType,
          channelId: data.channel_id,
          threadKey: payload?.streamPath,
          messageId: data.id,
          authorId: data.author?.id,
          authorUsername: data.author?.username || data.member?.nick,
          guildId: data.guild_id,
          text: data.content || "",
          referencedMessageId: data.message_reference?.message_id,
        },
        response: {
          sendMessage: {
            channelId: data.channel_id,
            content: "<your reply>",
            replyToMessageId: data.id,
          },
          addReaction: {
            channelId: data.channel_id,
            messageId: data.id,
            emoji: "<emoji>",
          },
        },
      }),
    },
  };
}

function discordWebsocketMessageReceivedEvent(args: {
  dispatchType: string;
  data: any;
  streamPath: string;
  sequence?: number | null;
  receivedAt: string;
}) {
  return {
    type: "events.iterate.com/discord/websocket-message-received",
    payload: {
      dispatchType: args.dispatchType,
      data: args.data,
      streamPath: args.streamPath,
      sequence: args.sequence ?? null,
      receivedAt: args.receivedAt,
    },
    idempotencyKey: `discord-websocket-message:${args.dispatchType}:${args.data?.id || args.sequence || Date.now()}`,
  };
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

  request(method: string, path: string, body?: unknown) {
    return this.#call(method, path, body);
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const hasBody = body !== undefined && method !== "GET";
    const resp = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
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
    const resp = await fetch(`${base}/api/streams/${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
    if (!resp.ok) throw new Error(`stream append failed: ${resp.status}`);
    const json = (await resp.json()) as any;
    return json.event ?? event;
  }

  #defaultEventsText(): string {
    if (this.#config("defaultEventsCustom") === "1") {
      return this.#config("defaultEvents") || defaultEventsText();
    }
    return defaultEventsText();
  }

  async #processAgentEvent(path: string, event: unknown): Promise<void> {
    const host = this.#config("hostHeader") || "";
    const agentsHost = host.replace(/^discord\./, "agents.");
    await fetch(`https://${agentsHost}/streams/${encodeURIComponent(path)}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  }

  async #appendAndProcessAgentEvent(path: string, event: any): Promise<any> {
    const appendedEvent = await this.#appendToStream(path, event);
    await this.#processAgentEvent(path, appendedEvent);
    return appendedEvent;
  }

  async #ensureDefaultEvents(path: string): Promise<void> {
    const text = this.#defaultEventsText();
    const hash = simpleHash(text);
    const key = `defaultEventsApplied:${path}`;
    if (this.#config(key) === hash) return;
    const events = parseDefaultEvents(text);
    for (let i = 0; i < events.length; i++) {
      await this.#appendAndProcessAgentEvent(path, {
        ...events[i],
        idempotencyKey: events[i].idempotencyKey ?? `default-event:discord:${hash}:${i}`,
      });
    }
    this.#setConfig(key, hash);
  }

  #discordThreadKey(d: any): string {
    const referencedMessageId = d.message_reference?.message_id;
    if (referencedMessageId) {
      const existing = this.#config(`discordThreadByMessage:${referencedMessageId}`);
      if (existing) return existing;
      return `${d.channel_id}-${referencedMessageId}`;
    }
    return `${d.channel_id}-${d.id}`;
  }

  #discordAgentPath(d: any): string {
    return `/agents/discord/thread-${this.#discordThreadKey(d)}`;
  }

  async #routeToAgent(d: any) {
    const agentPath = this.#discordAgentPath(d);
    const rawEvent = discordWebsocketMessageReceivedEvent({
      dispatchType: "MESSAGE_CREATE",
      data: d,
      streamPath: agentPath,
      sequence: this.#sequence,
      receivedAt: new Date().toISOString(),
    });
    try {
      await this.#appendToStream("/discord/websocket-messages", rawEvent);
    } catch (e: any) {
      console.error(`[Discord] raw websocket message append failed: ${e.message}`);
    }

    const dedupKey = `seen:${d.id}`;
    if (
      this.ctx.storage.sql.exec("SELECT 1 FROM config WHERE key = ?", dedupKey).toArray().length
    ) {
      return;
    }
    this.#setConfig(dedupKey, "1");
    this.#setConfig(`discordThreadByMessage:${d.id}`, this.#discordThreadKey(d));

    try {
      await this.#client().addReaction(d.channel_id, d.id, "👀");
    } catch (e: any) {
      console.error(`[Discord] reaction failed: ${e.message}`);
    }

    await this.#ensureDefaultEvents(agentPath);

    try {
      await this.#appendToStream(agentPath, rawEvent);
    } catch (e: any) {
      console.error(`[Discord] stream append failed: ${e.message}`);
    }

    const agentInputEvent = agentInputForDiscordMessage({ rawEvent });
    let appendedInput = agentInputEvent;
    try {
      appendedInput = await this.#appendToStream(agentPath, agentInputEvent);
    } catch (e: any) {
      console.error(`[Discord] agent-input append failed: ${e.message}`);
    }

    try {
      await this.#processAgentEvent(agentPath, appendedInput);
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
    try {
      return await this.#fetchImpl(req);
    } catch (e: any) {
      console.error(`[Discord] fetch failed: ${e?.message || String(e)}`);
      return Response.json(
        { ok: false, error: e?.message || String(e), stack: e?.stack || null },
        { status: 500 },
      );
    }
  }

  async #fetchImpl(req: Request): Promise<Response> {
    this.#ensureTables();
    const path = getPathname(req.url);

    if (path === "/" && req.method === "GET") {
      return new Response(defaultEventsEditorHtml("Discord"), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    if (path === "/api/default-events" && req.method === "GET") {
      return Response.json({ eventsText: this.#defaultEventsText() });
    }
    if (path === "/api/default-events" && req.method === "POST") {
      const body = (await req.json()) as { eventsText?: string };
      const eventsText = String(body.eventsText ?? "");
      try {
        parseDefaultEvents(eventsText);
      } catch (e: any) {
        return Response.json({ ok: false, error: e.message }, { status: 400 });
      }
      this.#setConfig("defaultEvents", eventsText);
      this.#setConfig("defaultEventsCustom", "1");
      return Response.json({ ok: true });
    }

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
    if (path === "/api/rpc/request" && req.method === "POST") {
      const body = (await req.json()) as any;
      return Response.json(await this.#client().request(body.method, body.path, body.body));
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
        "/rpc/request": {
          post: {
            operationId: "request",
            tags: ["discord"],
            description:
              "Thin Discord REST API proxy using the bot token. Docs: https://discord.com/developers/docs/reference",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["method", "path"],
                    properties: {
                      method: { type: "string", description: "HTTP method, e.g. GET or POST" },
                      path: {
                        type: "string",
                        description: "Discord API path, e.g. /channels/{id}",
                      },
                      body: { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "Discord API response" } },
          },
        },
      },
    };
  }
}
