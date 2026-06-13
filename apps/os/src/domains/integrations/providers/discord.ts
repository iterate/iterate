// Discord as an IntegrationDefinition. Two transports, one capture
// convention: the interactions WEBHOOK (the partial fetch function below) and
// the GATEWAY websocket the DiscordGatewayDurableObject holds open — both land
// verbatim on the same global ingress stream, keyed by guild.
// itx.integrations.discord.api IS @discordjs/core's API, authenticated from
// the project's `discord/bot-token` Secret.

import { REST, type RESTOptions } from "@discordjs/rest";
import { API } from "@discordjs/core/http-only";
import type { IntegrationDefinition } from "~/domains/integrations/definition.ts";
import { verifyEd25519Hex } from "~/domains/integrations/providers/verify.ts";

export const DISCORD_BOT_TOKEN_SECRET_NAME = "bot-token";

/** Routing key for a raw gateway frame ({ op, t, s, d }) — exported for the
 * gateway DO so both transports key events identically. */
export function discordGatewayRoutingKey(frame: unknown): string | null {
  const guildId = (frame as { d?: { guild_id?: string } })?.d?.guild_id;
  return guildId == null ? null : `guild:${guildId}`;
}

export const discordIntegration: IntegrationDefinition = {
  slug: "discord",
  displayName: "Discord",
  instructions:
    "Discord for this project. itx.integrations.discord.api is a ready-authenticated " +
    "@discordjs/core API client — e.g. itx.integrations.discord.api.channels.createMessage(channelId, { content }). " +
    "itx.integrations.discord.rest is the underlying @discordjs/rest client. Gateway " +
    "dispatches and interaction webhooks land on this project's /integrations/discord stream.",

  // The partial fetch function: Discord interaction webhooks (ed25519-signed).
  async fetch({ request, env, capture }) {
    if (new URL(request.url).pathname !== "/api/integrations/discord/webhook") return null;

    const publicKey = env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      return Response.json(
        { error: "Discord webhook ingress is not configured." },
        { status: 503 },
      );
    }

    const bodyText = await request.text();
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const valid =
      signature != null &&
      timestamp != null &&
      (await verifyEd25519Hex({
        publicKeyHex: publicKey,
        signatureHex: signature,
        message: `${timestamp}${bodyText}`,
      }).catch(() => false));
    if (!valid) {
      return Response.json({ error: "Invalid Discord webhook signature." }, { status: 401 });
    }

    const body = JSON.parse(bodyText) as { type?: number; id?: string; guild_id?: string };
    // Discord requires PING answered with PONG at the edge.
    if (body.type === 1) return Response.json({ type: 1 });

    await capture({
      transport: "webhook",
      routingKey: body.guild_id == null ? null : `guild:${body.guild_id}`,
      idempotencyKey: body.id == null ? null : `interaction:${body.id}`,
      body,
    });
    // Capture gates the ack, but Discord only accepts interaction CALLBACKS
    // here: autocomplete (4) must answer inline (no suggestions), components
    // (3) defer their message update, everything else defers a fresh
    // response — the real answer follows over REST.
    if (body.type === 4) return Response.json({ type: 8, data: { choices: [] } });
    return Response.json({ type: body.type === 3 ? 6 : 5 });
  },

  providedSecrets: [
    {
      name: DISCORD_BOT_TOKEN_SECRET_NAME,
      description: "Discord bot token used by the gateway connection and itx.integrations.discord.",
    },
  ],

  async createSdk(ctx) {
    // The "token" is a getSecret placeholder, substituted by ctx.fetch (the
    // terminal egress pipe) on the way out — the REST client never holds
    // material. makeRequest override per @discordjs/rest docs (the default
    // transport is undici, which workerd does not ship).
    const rest = new REST({
      version: "10",
      makeRequest: ctx.fetch as unknown as RESTOptions["makeRequest"],
    }).setToken(ctx.secretRef(DISCORD_BOT_TOKEN_SECRET_NAME));
    return { api: new API(rest), rest };
  },
};
