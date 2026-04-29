/**
 * Slack App — bidirectional bridge between Slack and agent streams.
 *
 * Flow:
 *   Slack webhook → POST /api/webhook → eyes emoji + events.iterate.com/agent/input-added → agent stream
 *   Agent (CodeMode) → POST /api/rpc/<slack.method> → Slack Web API
 *
 * Single class: App DO. Manual OpenAPI-shaped API for codemode tools.
 */

import { DurableObject } from "cloudflare:workers";

// ── Slack API ───────────────────────────────────────────────────────────────

class SlackClient {
  constructor(private token: string) {}

  async apiCall(method: string, args: Record<string, unknown>) {
    const resp = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { ok: false, error: raw.slice(0, 200) };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
        "You are an Iterate Slack bot. Respond to Slack notifications by writing exactly one fenced `js` codemode block containing the program body directly. Top-level `await` and `return` are valid. Use the `slack` provider only. Do not call `webchat`. Keep the block short and complete. Never write prose outside the fence. For a top-level Slack message, `body.event.thread_ts` is absent; use `body.event.ts` as the reply `thread_ts` and as the reaction `timestamp`. For a thread reply, use `body.event.thread_ts` as `thread_ts` and `body.event.ts` as `timestamp`. Reply and react concurrently with `Promise.all([...])`.",
    },
  },
  {
    type: "events.iterate.com/agent/input-added",
    payload: {
      role: "user",
      content:
        "Slack policy: read the raw `events.iterate.com/slack/webhook-received` YAML. Use `event.payload.body.event.channel` as `channel`. Use `event.payload.body.event.thread_ts ?? event.payload.body.event.ts` as `thread_ts`. Use `event.payload.body.event.ts` as the reaction `timestamp`. For ordinary replies, return only `Promise.all([slack.chat.postMessage({ channel, thread_ts, text }), slack.reactions.add({ channel, timestamp, name })])`. For longer work, set Slack assistant thread status before/during the work and clear it at the end. Do not send a separate webchat confirmation.",
      triggerLlmRequest: { behaviour: "dont-trigger-request" },
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
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${appName} default events</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f7f7f4; color: #111827; }
    main { padding: 16px; height: 100vh; box-sizing: border-box; display: grid; grid-template-rows: auto 1fr auto; gap: 12px; }
    h1 { font-size: 16px; margin: 0; }
    textarea { width: 100%; height: 100%; box-sizing: border-box; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 12px; border: 1px solid #d4d4d0; border-radius: 6px; resize: none; }
    button { border: 1px solid #111827; background: #111827; color: white; border-radius: 6px; padding: 8px 12px; }
    #status { font-size: 12px; color: #4b5563; }
  </style>
</head>
<body>
  <main>
    <h1>${appName} default events</h1>
    <textarea id="events" spellcheck="false"></textarea>
    <div><button id="save">Save</button> <span id="status"></span></div>
  </main>
  <script>
    const textarea = document.getElementById("events");
    const status = document.getElementById("status");
    async function load() {
      const response = await fetch("/api/default-events");
      const data = await response.json();
      textarea.value = data.eventsText || "";
    }
    document.getElementById("save").addEventListener("click", async () => {
      status.textContent = "Saving...";
      const response = await fetch("/api/default-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventsText: textarea.value })
      });
      const data = await response.json();
      status.textContent = data.ok ? "Saved" : data.error || "Failed";
    });
    load().catch((error) => status.textContent = error.message);
  </script>
</body>
</html>`;
}

// ── Webhook parsing ─────────────────────────────────────────────────────────

interface SlackWebhookPayload {
  type: "event_callback" | "url_verification";
  challenge?: string;
  event_id?: string;
  event: any;
  authorizations?: Array<{ user_id: string; is_bot: boolean }>;
}

type ParsedEvent =
  | { case: "mention" | "fyi"; event: any; threadTs: string }
  | { case: "ignored"; reason: string };

function parseWebhookPayload(payload: SlackWebhookPayload): ParsedEvent {
  const event = payload.event;
  const botUserId = payload.authorizations?.find((a) => a.is_bot)?.user_id;

  if (event.type === "reaction_added" || event.type === "reaction_removed")
    return { case: "ignored", reason: "reaction (v2)" };
  if (!botUserId) return { case: "ignored", reason: "no bot user" };
  if ("user" in event && event.user === botUserId) return { case: "ignored", reason: "self" };
  const isBotMsg =
    ("bot_profile" in event && (event as any).bot_profile) ||
    ("subtype" in event && (event as any).subtype === "bot_message");
  if (isBotMsg && !(event.text && new RegExp(`<@${botUserId}>`).test(event.text)))
    return { case: "ignored", reason: "bot" };
  if ("hidden" in event && (event as any).hidden) return { case: "ignored", reason: "hidden" };

  const threadTs = (event as any).thread_ts || event.ts;
  if (!threadTs) return { case: "ignored", reason: "no ts" };

  const mentionsBot = Boolean(event.text && new RegExp(`<@${botUserId}>`).test(event.text));
  const isDM = "channel_type" in event && (event as any).channel_type === "im";
  const isNewThread = !(event as any).thread_ts;
  const isMention = event.type === "app_mention" || mentionsBot || (isDM && isNewThread);

  return { case: isMention ? "mention" : "fyi", event: event as any, threadTs };
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

function agentInputForSlackMessage(args: {
  rawEvent: { type: string; payload?: unknown; idempotencyKey?: string };
}) {
  return {
    type: "events.iterate.com/agent/input-added",
    idempotencyKey: `${args.rawEvent.idempotencyKey || crypto.randomUUID()}:agent-input`,
    payload: {
      role: "user",
      source: "slack",
      content: eventToYaml(args.rawEvent),
    },
  };
}

function slackWebhookReceivedEvent(args: {
  payload: any;
  receivedAt: string;
  host: string;
  idempotencyBase: string;
}) {
  return {
    type: "events.iterate.com/slack/webhook-received",
    payload: {
      body: args.payload,
      receivedAt: args.receivedAt,
      host: args.host,
    },
    idempotencyKey: `slack-webhook:${args.idempotencyBase}`,
  };
}

function hasDebugCommand(text: string | undefined): boolean {
  return /(^|\s)!debug(\s|$)/i.test(text ?? "");
}

function slackThreadUrl(args: { channel: string; threadTs: string }): string {
  return `https://iterate-com.slack.com/archives/${args.channel}/p${args.threadTs.replace(".", "")}?thread_ts=${args.threadTs}&cid=${args.channel}`;
}

function debugResponse(args: {
  eventsBaseUrl: string;
  projectSlug: string;
  hostHeader: string;
  agentPath: string;
  channel: string;
  threadTs: string;
  messageTs: string;
}): string {
  const eventsBase = args.eventsBaseUrl
    .replace(/\/+$/, "")
    .replace("://", `://${args.projectSlug}.`);
  const agentsHost = args.hostHeader.replace(/^slack\./, "agents.");
  const projectHomeUrl = `https://${args.projectSlug}.iterate-dev-jonas.app/`;
  const streamPathNoSlash = args.agentPath.replace(/^\//, "");
  const eventsUrl = `${eventsBase}/streams/${streamPathNoSlash}/?renderer=raw-pretty&composer=json`;
  const agentsMiniAppUrl = `https://${agentsHost}/?path=${encodeURIComponent(args.agentPath)}`;
  const slackAppUrl = `https://${args.hostHeader}/`;
  const slackApiUrl = `https://${args.hostHeader}/api/openapi.json`;

  return [
    "*Slack agent debug*",
    `• Agents mini app: <${agentsMiniAppUrl}|open stream>`,
    `• Slack mini app: <${slackAppUrl}|default-events textarea>`,
    `• Events app route: <${eventsUrl}|raw event stream>`,
    `• Project home: <${projectHomeUrl}|${args.projectSlug}>`,
    `• Slack thread: <${slackThreadUrl(args)}|open thread>`,
    `• Slack OpenAPI: <${slackApiUrl}|provider schema>`,
    "",
    "Identifiers:",
    `• streamPath: \`${args.agentPath}\``,
    `• channel: \`${args.channel}\``,
    `• thread_ts: \`${args.threadTs}\``,
    `• message_ts: \`${args.messageTs}\``,
  ].join("\n");
}

const STATUS_DEBOUNCE_MS = 200;

type SlackThreadContext = {
  channel: string;
  threadTs: string;
  emojiTimestamp?: string;
  emoji?: string;
  createdAtMs: number;
  addEmojiPromise: Promise<void>;
  cycleId: string;
  closing: boolean;
  lastStatusKey: string;
  statusTimer?: any;
};

function toSlackStatus(rawStatus: string): { status: string; loading_messages?: string[] } {
  if (!rawStatus) return { status: "" };
  const lower = rawStatus.toLowerCase();
  if (rawStatus.includes("✏️") || lower.includes("writing") || lower.includes("typing")) {
    return { status: "is typing...", loading_messages: [`${rawStatus}...`] };
  }
  if (rawStatus.includes("🤔") || lower.includes("thinking")) {
    return { status: "is thinking...", loading_messages: [`${rawStatus}...`] };
  }
  if (rawStatus.includes("🔧") || lower.includes("tool") || lower.includes("codemode")) {
    return { status: "is using tools...", loading_messages: [`${rawStatus}...`] };
  }
  return { status: "is working...", loading_messages: [`${rawStatus}...`] };
}

function slackOpenApiSpec(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Slack App API",
      version: "1.0.0",
      description: "Thin Slack Web API wrapper for agent codemode.",
    },
    servers: [{ url: baseUrl.replace(/\/+$/, "") }],
    paths: {
      "/rpc/apiCall": {
        post: {
          operationId: "apiCall",
          tags: ["slack"],
          description: "Call any Slack Web API method. Docs: https://api.slack.com/methods",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["method"],
                  properties: {
                    method: {
                      type: "string",
                      description: "Slack Web API method name, e.g. conversations.replies",
                    },
                    args: {
                      type: "object",
                      description: "Arguments for the Slack Web API method",
                      additionalProperties: true,
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Slack Web API response",
              content: { "application/json": { schema: {} } },
            },
          },
        },
      },
      "/rpc/chat.postMessage": {
        post: {
          operationId: "chat.postMessage",
          tags: ["slack"],
          description: "Slack Web API chat.postMessage.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["channel", "text"],
                  properties: {
                    channel: { type: "string", description: "Slack channel ID" },
                    thread_ts: { type: "string", description: "Slack thread timestamp" },
                    text: { type: "string", description: "Message text" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Slack Web API response",
              content: { "application/json": { schema: {} } },
            },
          },
        },
      },
      "/rpc/reactions.add": {
        post: {
          operationId: "reactions.add",
          tags: ["slack"],
          description: "Slack Web API reactions.add.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["channel", "timestamp", "name"],
                  properties: {
                    channel: { type: "string", description: "Slack channel ID" },
                    timestamp: { type: "string", description: "Slack message timestamp" },
                    name: { type: "string", description: "Emoji name without colons" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Slack Web API response",
              content: { "application/json": { schema: {} } },
            },
          },
        },
      },
      "/rpc/assistant.threads.setStatus": {
        post: {
          operationId: "assistant.threads.setStatus",
          tags: ["slack"],
          description: "Slack Web API assistant.threads.setStatus.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["channel_id", "thread_ts", "status"],
                  properties: {
                    channel_id: { type: "string", description: "Slack channel ID" },
                    thread_ts: { type: "string", description: "Slack thread timestamp" },
                    status: { type: "string", description: "Assistant thread status text" },
                    loading_messages: {
                      type: "array",
                      items: { type: "string" },
                      description: "Optional user-facing loading messages",
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Slack Web API response",
              content: { "application/json": { schema: {} } },
            },
          },
        },
      },
    },
  };
}

// ── App DO ───────────────────────────────────────────────────────────────────

export class App extends DurableObject {
  #slack: SlackClient | null = null;
  #threadContexts = new Map<string, SlackThreadContext>();

  #ensureTables() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`);
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

  #slackClient(): SlackClient {
    if (this.#slack) return this.#slack;
    const token = this.#config("slackBotToken");
    if (!token) throw new Error("No Slack token — run /api/install");
    this.#slack = new SlackClient(token);
    return this.#slack;
  }

  async #appendToStream(path: string, event: any) {
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

  async #processAgentEvent(path: string, event: any): Promise<any> {
    const host = this.#config("hostHeader") || "";
    const agentsHost = host.replace(/^slack\./, "agents.");
    const resp = await fetch(`https://${agentsHost}/streams/${encodeURIComponent(path)}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    const text = await resp.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!resp.ok) throw new Error(`agent process failed: ${resp.status}`);
    return body;
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
      const event = {
        ...events[i],
        idempotencyKey: events[i].idempotencyKey ?? `default-event:slack:${hash}:${i}`,
      };
      await this.#appendAndProcessAgentEvent(path, event);
    }
    this.#setConfig(key, hash);
  }

  #ensureSlackThreadContext(params: {
    agentPath: string;
    channel: string;
    threadTs: string;
    emojiTimestamp?: string;
    emoji?: string;
  }): SlackThreadContext {
    const existing = this.#threadContexts.get(params.agentPath);
    if (existing && !existing.closing) return existing;

    const context: SlackThreadContext = {
      channel: params.channel,
      threadTs: params.threadTs,
      emojiTimestamp: params.emojiTimestamp,
      emoji: params.emoji,
      createdAtMs: Date.now(),
      addEmojiPromise: Promise.resolve(),
      cycleId: crypto.randomUUID(),
      closing: false,
      lastStatusKey: "",
    };
    this.#threadContexts.set(params.agentPath, context);
    if (context.emoji && context.emojiTimestamp) {
      context.addEmojiPromise = this.#addReaction(context);
      void context.addEmojiPromise;
    }
    return context;
  }

  #scheduleThreadStatusUpdate(
    agentPath: string,
    context: SlackThreadContext,
    rawStatus: string,
  ): void {
    if (context.closing) return;
    const statusKey = JSON.stringify(toSlackStatus(rawStatus));
    if (statusKey === context.lastStatusKey) return;
    if (context.statusTimer) clearTimeout(context.statusTimer);
    const cycleId = context.cycleId;
    context.statusTimer = setTimeout(() => {
      void this.#flushThreadStatusUpdate(agentPath, context, cycleId, rawStatus, statusKey);
    }, STATUS_DEBOUNCE_MS);
  }

  async #flushThreadStatusUpdate(
    agentPath: string,
    context: SlackThreadContext,
    cycleId: string,
    rawStatus: string,
    statusKey: string,
  ): Promise<void> {
    if (context.closing) return;
    if (this.#threadContexts.get(agentPath)?.cycleId !== cycleId) return;
    await context.addEmojiPromise;
    if (context.closing) return;
    if (this.#threadContexts.get(agentPath)?.cycleId !== cycleId) return;
    await this.#setThreadStatus(context, rawStatus);
    context.lastStatusKey = statusKey;
  }

  async #cleanupSlackThreadContext(agentPath: string, context: SlackThreadContext): Promise<void> {
    if (context.closing) return;
    context.closing = true;
    if (context.statusTimer) clearTimeout(context.statusTimer);
    context.statusTimer = undefined;

    await context.addEmojiPromise;
    await Promise.allSettled([this.#removeReaction(context), this.#setThreadStatus(context, "")]);

    if (this.#threadContexts.get(agentPath)?.cycleId === context.cycleId) {
      this.#threadContexts.delete(agentPath);
    }
  }

  async #addReaction(context: SlackThreadContext): Promise<void> {
    if (!context.emoji || !context.emojiTimestamp) return;
    const result = await this.#slackClient().apiCall("reactions.add", {
      channel: context.channel,
      timestamp: context.emojiTimestamp,
      name: context.emoji,
    });
    if (result?.ok === false && result.error !== "already_reacted") {
      console.error("[Slack] add reaction failed", result);
    }
  }

  async #removeReaction(context: SlackThreadContext): Promise<void> {
    if (!context.emoji || !context.emojiTimestamp) return;
    const result = await this.#slackClient().apiCall("reactions.remove", {
      channel: context.channel,
      timestamp: context.emojiTimestamp,
      name: context.emoji,
    });
    if (result?.ok === false && result.error !== "no_reaction") {
      console.error("[Slack] remove reaction failed", result);
    }
  }

  async #setThreadStatus(context: SlackThreadContext, rawStatus: string): Promise<void> {
    const { status, loading_messages } = toSlackStatus(rawStatus);
    const result = await this.#slackClient().apiCall("assistant.threads.setStatus", {
      channel_id: context.channel,
      thread_ts: context.threadTs,
      status,
      ...(loading_messages ? { loading_messages } : {}),
    });
    if (result?.ok === false) {
      console.error("[Slack] set thread status failed", result);
    } else {
      console.log("[Slack] set thread status ok", {
        channel: context.channel,
        threadTs: context.threadTs,
        status,
      });
    }
  }

  async fetch(req: Request): Promise<Response> {
    this.#ensureTables();
    const path = getPathname(req.url);

    if (path === "/" && req.method === "GET") {
      return new Response(defaultEventsEditorHtml("Slack"), {
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

    if (path === "/api/webhook" && req.method === "POST") return this.#webhook(req);
    if (path === "/api/install") return this.#install(req);
    if (path === "/api/config")
      return Response.json(this.ctx.storage.sql.exec("SELECT * FROM config").toArray());
    if (path === "/api/openapi.json" && req.method === "GET") {
      return Response.json(slackOpenApiSpec(new URL("/api", req.url).toString()));
    }
    if (path === "/api/docs" && req.method === "GET") {
      return new Response("Slack API docs: GET /api/openapi.json, POST /api/rpc/<slack.method>", {
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    }
    if (path.startsWith("/api/rpc/") && req.method === "POST") {
      try {
        const method = decodeURIComponent(path.slice("/api/rpc/".length));
        const body = (await req.json()) as Record<string, unknown>;
        if (method === "apiCall") {
          if (typeof body.method !== "string") {
            return Response.json({ ok: false, error: "method must be a string" }, { status: 400 });
          }
          const args =
            body.args != null && typeof body.args === "object" && !Array.isArray(body.args)
              ? (body.args as Record<string, unknown>)
              : {};
          return Response.json(await this.#slackClient().apiCall(body.method, args));
        }
        return Response.json(await this.#slackClient().apiCall(method, body));
      } catch (e: any) {
        return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
      }
    }
    return new Response("Slack App — /api/install to set up, /api/docs for API reference");
  }

  async #webhook(req: Request): Promise<Response> {
    try {
      return await this.#webhookImpl(req);
    } catch (e: any) {
      console.error(`[Slack] webhook failed: ${e?.message || String(e)}`);
      return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
  }

  async #webhookImpl(req: Request): Promise<Response> {
    let payload: any;
    const raw = await req.text();
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = Object.fromEntries(new URLSearchParams(raw));
    }

    if (payload.ssl_check) return Response.json({ ok: true });
    if (payload.type === "url_verification")
      return new Response(payload.challenge, { headers: { "content-type": "text/plain" } });
    if (payload.type !== "event_callback") return Response.json({ ok: true, ignored: true });

    const slackWebhookEvent = slackWebhookReceivedEvent({
      payload,
      receivedAt: new Date().toISOString(),
      host: req.headers.get("host") || "",
      idempotencyBase: payload.event_id || payload.event?.ts || crypto.randomUUID(),
    });

    try {
      await this.#appendToStream("/slack/webhooks", slackWebhookEvent);
    } catch (e: any) {
      console.error(`[Slack] raw webhook append failed: ${e.message}`);
    }

    const parsed = parseWebhookPayload(payload);
    if (parsed.case === "ignored")
      return Response.json({ ok: true, ignored: true, reason: parsed.reason });

    const event = parsed.event;
    const channel = event.channel || "";
    const threadTs = parsed.threadTs;
    const threadKey = `agent-thread:${threadTs}`;
    const isKnownThread = this.#config(threadKey) === "1";
    const msgTs = parsed.event.ts;
    const isDebug = hasDebugCommand(event.text);

    // Dedup by message ts (Slack retries + multiple event types for same message)
    if (msgTs) {
      const seen = this.ctx.storage.sql
        .exec("SELECT 1 FROM config WHERE key = ?", `seen:${msgTs}`)
        .toArray();
      if (seen.length) return Response.json({ ok: true, duplicate: true });
      this.#setConfig(`seen:${msgTs}`, "1");
    }

    const agentPath = `/agents/slack/ts-${threadTs.replace(/\./g, "-")}`;

    if (isDebug) {
      this.#setConfig(threadKey, "1");
      const eventsBaseUrl = this.#config("eventsBaseUrl") || "https://events.iterate.com";
      const projectSlug = this.#config("projectSlug") || "test";
      const hostHeader = this.#config("hostHeader") || "slack.test.iterate-dev-jonas.app";
      const result = await this.#slackClient().apiCall("chat.postMessage", {
        channel,
        thread_ts: threadTs,
        text: debugResponse({
          eventsBaseUrl,
          projectSlug,
          hostHeader,
          agentPath,
          channel,
          threadTs,
          messageTs: msgTs || threadTs,
        }),
      });
      return Response.json({ ok: true, debug: true, result });
    }

    if (parsed.case === "fyi" && !isKnownThread) {
      return Response.json({ ok: true, ignored: true, reason: "not mentioned" });
    }

    this.#setConfig(threadKey, "1");

    const slackContext = this.#ensureSlackThreadContext({
      agentPath,
      channel,
      threadTs,
      emojiTimestamp: parsed.case === "mention" ? event.ts : undefined,
      emoji: parsed.case === "mention" ? "eyes" : undefined,
    });

    try {
      await this.#ensureDefaultEvents(agentPath);

      // Cross-post the raw webhook verbatim, then append the channel-derived
      // agent input. The generic agents processor does not parse Slack payloads.
      try {
        await this.#appendToStream(agentPath, slackWebhookEvent);
      } catch (e: any) {
        console.error(`[Slack] stream append failed: ${e.message}`);
      }

      this.#scheduleThreadStatusUpdate(agentPath, slackContext, "🤔 Thinking");
      const agentInput = await this.#appendToStream(
        agentPath,
        agentInputForSlackMessage({ rawEvent: slackWebhookEvent }),
      );
      await this.#processAgentEvent(agentPath, agentInput);
    } catch (e: any) {
      console.error(`[Slack] direct agent trigger failed: ${e.message}`);
    } finally {
      await this.#cleanupSlackThreadContext(agentPath, slackContext);
    }

    return Response.json({ ok: true, eventId: payload.event_id, agentPath });
  }

  async #install(req: Request): Promise<Response> {
    const host = req.headers.get("host") || "localhost";
    const params: Record<string, string> = {};
    const qIdx = req.url.indexOf("?");
    if (qIdx !== -1)
      for (const p of req.url.slice(qIdx + 1).split("&")) {
        const [k, v] = p.split("=");
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    if (req.method === "POST")
      try {
        Object.assign(params, await req.json());
      } catch {}

    const projectSlug = params.projectSlug || this.#config("projectSlug") || "";
    if (!projectSlug) return Response.json({ error: "projectSlug required" }, { status: 400 });

    this.#setConfig(
      "eventsBaseUrl",
      params.eventsBaseUrl || this.#config("eventsBaseUrl") || "https://events.iterate.com",
    );
    this.#setConfig("projectSlug", projectSlug);
    this.#setConfig("hostHeader", host);
    if (params.slackBotToken) {
      this.#setConfig("slackBotToken", params.slackBotToken);
      this.#slack = null;
    }

    return Response.json({ ok: true, webhookUrl: `https://${host}/api/webhook` });
  }
}
