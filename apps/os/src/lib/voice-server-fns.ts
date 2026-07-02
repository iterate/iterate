import { createServerFn } from "@tanstack/react-start";
import { getUserPrincipal } from "~/auth/principal.ts";

/**
 * Ephemeral credentials for a browser realtime voice session. The raw
 * provider API key never leaves the server: the browser gets a short-lived
 * client secret (`ek_…`) and passes it as a WebSocket subprotocol.
 */
export type VoiceRealtimeConnection = {
  provider: "openai";
  model: string;
  clientSecret: string;
  expiresAt: number;
};

export const mintVoiceRealtimeConnectionServerFn: () => Promise<VoiceRealtimeConnection> =
  createServerFn({ method: "POST" }).handler(async ({ context }) => {
    if (!getUserPrincipal(context.principal)) {
      throw new Error("Sign in to start a voice session.");
    }
    // OpenAI Realtime only for now: AppConfig has no xAI key yet. The Grok
    // Voice Agent API is wire-compatible (subprotocol `xai-client-secret.…`),
    // so adding it later is a config field + a branch here.
    const model = "gpt-realtime";
    const apiKey = context.config.openAiApiKey.exposeSecret();
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
  });
