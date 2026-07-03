import type { AppConfig } from "../../config.ts";
import type { VoiceRealtimeConnection } from "../../types.ts";

/**
 * Mint an ephemeral realtime client secret for a voice session. Shared by the
 * dashboard server fn and the itx `voice.mintRealtimeConnection()` capability —
 * the raw provider API key stays server-side in both lanes.
 *
 * OpenAI Realtime only for now: AppConfig has no xAI key yet. The Grok Voice
 * Agent API is wire-compatible, so adding it later is a config field + a
 * branch here.
 */
export async function mintVoiceRealtimeConnection(
  config: AppConfig,
): Promise<VoiceRealtimeConnection> {
  const model = "gpt-realtime";
  const apiKey = config.openAiApiKey.exposeSecret();
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: { type: "realtime", model } }),
  });
  if (!response.ok) {
    throw new Error(`Failed to mint realtime client secret: ${await response.text()}`);
  }
  const minted = (await response.json()) as { value: string; expires_at: number };
  return { provider: "openai", model, clientSecret: minted.value, expiresAt: minted.expires_at };
}
