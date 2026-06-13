/**
 * Discord-gateway worker: one DO per connected Discord account — holds the
 * gateway WebSocket connection so inbound events reach the capture stream.
 */
export { DiscordGatewayDurableObject } from "~/domains/integrations/durable-objects/discord-gateway-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-discord-gateway" }, { status: 404 }),
};
