import { createServerFn } from "@tanstack/react-start";
import { getUserPrincipal } from "~/auth/principal.ts";
import { mintVoiceRealtimeConnection } from "~/domains/voice/mint-realtime-connection.ts";
import type { VoiceRealtimeConnection } from "~/types.ts";

export type { VoiceRealtimeConnection };

/**
 * Ephemeral credentials for a browser realtime voice session — the dashboard
 * lane of `mintVoiceRealtimeConnection` (itx clients use
 * `itx.voice.mintRealtimeConnection()` instead).
 */
export const mintVoiceRealtimeConnectionServerFn: () => Promise<VoiceRealtimeConnection> =
  createServerFn({ method: "POST" }).handler(async ({ context }) => {
    if (!getUserPrincipal(context.principal)) {
      throw new Error("Sign in to start a voice session.");
    }
    return mintVoiceRealtimeConnection(context.config);
  });
