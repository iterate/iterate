// The Discord GATEWAY connection holder — the transport Discord doesn't offer
// as webhooks. One instance per scope: "first-party" holds the deployment
// bot's single websocket; "project:{projectId}" holds a customer-owned bot's.
//
// This DO is deliberately NOT a stream processor host. It is the websocket
// twin of the webhook ingress handler (webhook-ingress.ts): it speaks the
// gateway protocol (identify, heartbeat, resume) and appends every dispatch
// VERBATIM to the same global capture stream
// `{global}:/integrations/discord/webhooks`, as the same
// `integration/event-received` type with `transport: "gateway"`. Everything
// downstream — routing by guild, project lifecycle stream, agents — cannot
// tell which transport an event arrived on. That symmetry is the point.
//
// What the gateway teases out that webhooks don't:
// - the connection needs a HOME (this DO) and a lifetime beyond any request;
//   a client websocket pins the DO awake, which is a real cost to discuss.
// - reconnection is OUR job (alarm-based backoff, resume with session_id),
//   where webhook retries are the provider's.
// - the bot token is needed as BYTES IN HAND for the identify frame — fetch
//   substitution can't cover it, which is exactly what the Secret DO's
//   audited revealForPlatformUse trapdoor is for.

import { env } from "cloudflare:workers";
import { z } from "zod";
import { GatewayIntentBits } from "discord-api-types/v10";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getDiscordGatewayDurableObjectName } from "~/domains/integrations/integration-naming.ts";
import { captureIntegrationEvent } from "~/domains/integrations/ingress.ts";
import {
  DISCORD_BOT_TOKEN_SECRET_NAME,
  discordGatewayRoutingKey,
} from "~/domains/integrations/providers/discord.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import { revealJournaledSecretForPlatformUse } from "~/domains/secrets/secret-streams.ts";

export { getDiscordGatewayDurableObjectName };

const DiscordGatewayDurableObjectStructuredName = z.object({
  scope: z.string().trim().min(1),
});
export type DiscordGatewayDurableObjectStructuredName = z.infer<
  typeof DiscordGatewayDurableObjectStructuredName
>;

/** Mint an initialized gateway DO stub from a trusted domain file (see lint rule). */
export async function ensureDiscordGatewayStub(scope: string) {
  return await getInitializedDoStub({
    allowCreate: true,
    name: { scope },
    namespace: (env as unknown as DiscordGatewayEnv).DISCORD_GATEWAY,
  });
}

type DiscordGatewayEnv = {
  APP_CONFIG_DISCORD_BOT_TOKEN?: string;
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDurableObject>;
  DO_CATALOG: D1Database;
};

const DiscordGatewayLifecycleBase = createIterateDurableObjectBase<
  typeof DiscordGatewayDurableObjectStructuredName,
  Pick<DiscordGatewayEnv, "DO_CATALOG">
>({
  className: "DiscordGatewayDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  nameSchema: DiscordGatewayDurableObjectStructuredName,
});

const GATEWAY_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildMessageReactions |
  GatewayIntentBits.MessageContent;

type GatewayFrame = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

export class DiscordGatewayDurableObject extends DiscordGatewayLifecycleBase<DiscordGatewayEnv> {
  #socket: WebSocket | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #sequence: number | null = null;
  #sessionId: string | null = null;
  #resumeUrl: string | null = null;

  /** Idempotent: dial this after connect/deploy to (re)establish the socket. */
  async ensureConnected() {
    const params = await this.ensureStarted();
    if (this.#socket?.readyState === WebSocket.OPEN) {
      return { connected: true as const, alreadyConnected: true };
    }
    await this.openGatewaySocket(params);
    return { connected: true as const, alreadyConnected: false };
  }

  async status() {
    return {
      socketState: this.#socket?.readyState ?? null,
      sequence: this.#sequence,
      sessionId: this.#sessionId,
    };
  }

  async disconnect() {
    this.teardown();
    await this.ctx.storage.deleteAlarm();
  }

  /** Reconnect backoff lands here. */
  async alarm() {
    const params = await this.ensureStarted();
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    await this.openGatewaySocket(params);
  }

  private async openGatewaySocket(params: DiscordGatewayDurableObjectStructuredName) {
    this.teardown();
    const token = await this.botToken(params);
    const url = this.#resumeUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as GatewayFrame;
      void this.handleFrame(frame, token).catch((error) => {
        console.error("[discord-gateway] frame handling failed", { error, op: frame.op });
      });
    });
    socket.addEventListener("close", (event) => {
      console.warn("[discord-gateway] socket closed", { code: event.code, scope: params.scope });
      this.teardown();
      // Resume-or-reidentify on the next alarm; cheap fixed backoff for the spike.
      void this.ctx.storage.setAlarm(Date.now() + 5_000);
    });
    socket.addEventListener("error", () => {
      // close fires next; the alarm path owns recovery.
    });
  }

  private async handleFrame(frame: GatewayFrame, token: string) {
    if (frame.s != null) this.#sequence = frame.s;
    switch (frame.op) {
      case 10: {
        // HELLO → heartbeat forever, then identify (or resume).
        const heartbeatIntervalMs = (frame.d as { heartbeat_interval: number }).heartbeat_interval;
        this.#heartbeatTimer = setInterval(() => {
          this.send({ op: 1, d: this.#sequence });
        }, heartbeatIntervalMs);
        if (this.#sessionId != null) {
          this.send({
            op: 6,
            d: { token, session_id: this.#sessionId, seq: this.#sequence },
          });
        } else {
          this.send({
            op: 2,
            d: {
              token,
              intents: GATEWAY_INTENTS,
              properties: { os: "workerd", browser: "iterate-os", device: "iterate-os" },
            },
          });
        }
        return;
      }
      case 1:
        this.send({ op: 1, d: this.#sequence });
        return;
      case 0:
        await this.handleDispatch(frame);
        return;
      case 7: // RECONNECT
      case 9: {
        // INVALID SESSION: d === false means the session is unresumable.
        if (frame.op === 9 && frame.d === false) {
          this.#sessionId = null;
          this.#resumeUrl = null;
        }
        this.#socket?.close(1000);
        return;
      }
      default:
        return;
    }
  }

  private async handleDispatch(frame: GatewayFrame) {
    if (frame.t === "READY") {
      const ready = frame.d as { session_id: string; resume_gateway_url: string };
      this.#sessionId = ready.session_id;
      this.#resumeUrl = `${ready.resume_gateway_url}?v=10&encoding=json`;
      return;
    }
    if (frame.t === "RESUMED") return;

    // Same capture primitive as a webhook POST: verbatim frame, keyed by
    // guild, transport-blind downstream.
    const params = await this.ensureStarted();
    await captureIntegrationEvent({
      integration: "discord",
      transport: "gateway",
      routingKey: discordGatewayRoutingKey(frame),
      idempotencyKey: frame.s == null ? null : `${params.scope}:seq:${frame.s}:${frame.t ?? ""}`,
      body: frame,
    });
  }

  private async botToken(params: DiscordGatewayDurableObjectStructuredName) {
    if (params.scope.startsWith("project:")) {
      // Customer-owned bot: scope is "project:{projectId}:{account}" and the
      // token is that account's Secret — the gateway is a secret USER,
      // dereferencing via the audited trapdoor.
      const [, projectId, account = "default"] = params.scope.split(":");
      return await revealJournaledSecretForPlatformUse({
        projectId: projectId!,
        slug: providedSecretSlug({
          integration: "discord",
          account,
          name: DISCORD_BOT_TOKEN_SECRET_NAME,
        }),
        usedBy: "discord-gateway",
      });
    }
    if (!this.env.APP_CONFIG_DISCORD_BOT_TOKEN) {
      throw new Error("APP_CONFIG_DISCORD_BOT_TOKEN is not configured for this deployment.");
    }
    return this.env.APP_CONFIG_DISCORD_BOT_TOKEN;
  }

  private send(frame: GatewayFrame) {
    this.#socket?.send(JSON.stringify(frame));
  }

  private teardown() {
    if (this.#heartbeatTimer != null) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    try {
      this.#socket?.close(1000);
    } catch {
      // already closed
    }
    this.#socket = null;
  }
}
