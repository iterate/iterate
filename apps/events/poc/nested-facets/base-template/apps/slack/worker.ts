/**
 * Slack App — bidirectional bridge between Slack and agent streams.
 *
 * Flow:
 *   Slack webhook → POST /api/webhook → eyes emoji + agent-input-added → agent stream
 *   Agent (CodeMode) → POST /api/rpc/replyToThread → chat.postMessage → Slack
 *   Agent (CodeMode) → POST /api/rpc/reactToMessage → reactions.add → Slack
 *
 * Single class: App DO. oRPC for the API, Scalar for docs.
 */

import { DurableObject } from "cloudflare:workers";
import { oc } from "@orpc/contract";
import { implement, onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { z } from "zod";
import type {
  AppMentionEvent,
  GenericMessageEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from "@slack/types";

// ── Slack API ───────────────────────────────────────────────────────────────

class SlackClient {
  constructor(private token: string) {}
  postMessage(channel: string, threadTs: string, text: string) {
    return this.#call("chat.postMessage", { channel, thread_ts: threadTs, text });
  }
  addReaction(channel: string, timestamp: string, name: string) {
    return this.#call("reactions.add", { channel, timestamp, name });
  }
  async #call(method: string, body: any): Promise<any> {
    const resp = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
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

// ── Webhook parsing ─────────────────────────────────────────────────────────

interface SlackWebhookPayload {
  type: "event_callback" | "url_verification";
  challenge?: string;
  event_id?: string;
  event: AppMentionEvent | GenericMessageEvent | ReactionAddedEvent | ReactionRemovedEvent;
  authorizations?: Array<{ user_id: string; is_bot: boolean }>;
}

type ParsedEvent =
  | { case: "mention" | "fyi"; event: AppMentionEvent | GenericMessageEvent; threadTs: string }
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

  // Skip message events that duplicate app_mention
  if (event.type === "message" && event.text && new RegExp(`<@${botUserId}>`).test(event.text))
    return { case: "ignored", reason: "message duplicates app_mention" };

  const isDM = "channel_type" in event && (event as any).channel_type === "im";
  const isNewThread = !(event as any).thread_ts;
  const isMention = event.type === "app_mention" || (isDM && isNewThread);

  return { case: isMention ? "mention" : "fyi", event: event as any, threadTs };
}

function formatMessageForAgent(parsed: Extract<ParsedEvent, { case: "mention" | "fyi" }>): string {
  const { event, threadTs } = parsed;
  const text = event.text || "(no text)";
  const channel = event.channel || "";
  const messageTs = event.ts || threadTs;

  return [
    `You received a Slack message.`,
    `From: <@${event.user || "unknown"}>`,
    `Message: ${text}`,
    "",
    "To reply, call slack.replyToThread with these EXACT values:",
    `  channel: "${channel}"`,
    `  threadTs: "${threadTs}"`,
    `  messageTs: "${messageTs}"`,
  ].join("\n");
}

// ── oRPC contract ───────────────────────────────────────────────────────────

const slackContract = oc.router({
  replyToThread: oc
    .route({
      method: "POST",
      path: "/rpc/replyToThread",
      description:
        "Reply to a Slack thread. Pass channel and threadTs exactly as received in the message.",
      tags: ["slack"],
    })
    .input(
      z.object({
        channel: z.string().describe("Slack channel ID (e.g. C08R1SMTZGD)"),
        threadTs: z.string().describe("Thread timestamp (e.g. 1234567890.123456)"),
        text: z.string().describe("Message text"),
      }),
    )
    .output(z.object({ ok: z.boolean(), ts: z.string().optional(), error: z.string().optional() })),

  reactToMessage: oc
    .route({
      method: "POST",
      path: "/rpc/reactToMessage",
      description: "React to a Slack message with an emoji.",
      tags: ["slack"],
    })
    .input(
      z.object({
        channel: z.string().describe("Slack channel ID"),
        messageTs: z.string().describe("Message timestamp to react to"),
        emoji: z.string().describe("Emoji name without colons (e.g. eyes)"),
      }),
    )
    .output(z.object({ ok: z.boolean(), error: z.string().optional() })),
});

// ── App DO ───────────────────────────────────────────────────────────────────

export class App extends DurableObject {
  #slack: SlackClient | null = null;
  #apiHandler: OpenAPIHandler<typeof slackRouter, { slackClient: SlackClient }> | null = null;

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
    await fetch(`${base}/api/streams/${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    });
  }

  #getApiHandler() {
    if (this.#apiHandler) return this.#apiHandler;
    const client = this.#slackClient();
    this.#apiHandler = new OpenAPIHandler(slackRouter, {
      plugins: [
        new OpenAPIReferencePlugin({
          docsProvider: "scalar",
          docsPath: "/docs",
          specPath: "/openapi.json",
          schemaConverters: [new ZodToJsonSchemaConverter()],
          specGenerateOptions: {
            info: {
              title: "Slack App API",
              version: "1.0.0",
              description:
                "Slack integration tools for agents. Reply to threads and react to messages.",
            },
          },
        }),
      ],
      interceptors: [onError((error) => console.error("[Slack API]", error))],
    });
    return this.#apiHandler;
  }

  async fetch(req: Request): Promise<Response> {
    this.#ensureTables();
    const path = getPathname(req.url);

    if (path === "/api/webhook" && req.method === "POST") return this.#webhook(req);
    if (path === "/api/install") return this.#install(req);
    if (path === "/api/config")
      return Response.json(this.ctx.storage.sql.exec("SELECT * FROM config").toArray());

    // oRPC handles /api/rpc/*, /api/docs, /api/openapi.json
    if (path.startsWith("/api/")) {
      try {
        const handler = this.#getApiHandler();
        const { matched, response } = await handler.handle(req, {
          prefix: "/api",
          context: { slackClient: this.#slackClient() },
        });
        if (matched && response) return response;
      } catch (e: any) {
        // If Slack token not configured, docs/spec still fail gracefully
        if (path === "/api/docs" || path === "/api/openapi.json") {
          return new Response("Run /api/install first to configure the Slack token", {
            status: 500,
          });
        }
      }
    }

    return new Response("Slack App — /api/install to set up, /api/docs for API reference");
  }

  async #webhook(req: Request): Promise<Response> {
    let payload: any;
    try {
      payload = JSON.parse(await req.text());
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }

    if (payload.type === "url_verification")
      return new Response(payload.challenge, { headers: { "content-type": "text/plain" } });
    if (payload.type !== "event_callback") return Response.json({ ok: true, ignored: true });

    const parsed = parseWebhookPayload(payload);
    if (parsed.case === "ignored")
      return Response.json({ ok: true, ignored: true, reason: parsed.reason });

    // Dedup by message ts (Slack retries + multiple event types for same message)
    const msgTs = parsed.event.ts;
    if (msgTs) {
      const seen = this.ctx.storage.sql
        .exec("SELECT 1 FROM config WHERE key = ?", `seen:${msgTs}`)
        .toArray();
      if (seen.length) return Response.json({ ok: true, duplicate: true });
      this.#setConfig(`seen:${msgTs}`, "1");
    }

    const event = parsed.event;
    const channel = event.channel || "";
    const threadTs = parsed.threadTs;
    const agentPath = `/agents/slack/ts-${threadTs.replace(/\./g, "-")}`;

    // Eyes emoji (fire-and-forget)
    if (parsed.case === "mention" && channel && event.ts) {
      this.#slackClient()
        .addReaction(channel, event.ts, "eyes")
        .catch(() => {});
    }

    // Create agent stream first (triggers child-stream-created → agents auto-subscribe),
    // then wait for subscription to be active before appending the actual event.
    const idempotencyBase = payload.event_id || event.ts;
    const content = formatMessageForAgent(parsed);

    // Append event to the stream (for persistence/audit)
    const agentEvent = {
      type: "agent-input-added",
      payload: { role: "user", content, source: "slack" },
      idempotencyKey: `agent-input:${idempotencyBase}`,
    };
    try {
      await this.#appendToStream(agentPath, agentEvent);
    } catch (e: any) {
      console.error(`[Slack] stream append failed: ${e.message}`);
    }

    // Also POST directly to the agents processor to trigger the AI loop.
    // This avoids the subscription race (WebSocket not connected in time).
    const host = this.#config("hostHeader") || "";
    const agentsHost = host.replace(/^slack\./, "agents.");
    try {
      await fetch(`https://${agentsHost}/streams/${encodeURIComponent(agentPath)}/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(agentEvent),
      });
    } catch (e: any) {
      console.error(`[Slack] direct agent trigger failed: ${e.message}`);
    }

    return Response.json({ ok: true, eventId: payload.event_id });
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
      this.#apiHandler = null;
    }

    return Response.json({ ok: true, webhookUrl: `https://${host}/api/webhook` });
  }
}

// ── oRPC router (implemented outside the class, receives context) ───────────

type SlackContext = { slackClient: SlackClient };

const os = implement(slackContract).$context<SlackContext>();

const slackRouter = os.router({
  replyToThread: os.replyToThread.handler(async ({ context, input }) => {
    return context.slackClient.postMessage(input.channel, input.threadTs, input.text);
  }),

  reactToMessage: os.reactToMessage.handler(async ({ context, input }) => {
    const result = await context.slackClient.addReaction(
      input.channel,
      input.messageTs,
      input.emoji,
    );
    if (!result.ok && result.error === "already_reacted") return { ok: true };
    return result;
  }),
});
