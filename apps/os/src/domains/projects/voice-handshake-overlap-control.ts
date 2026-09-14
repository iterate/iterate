import { z } from "zod";

/** A strictly scoped Preview17 experiment; ordinary egress never uses this. */
export const VOICE_HANDSHAKE_OVERLAP_PROJECT_ID = "prj_56cbca83186a40019f5792b2463c81fa";
export const VOICE_HANDSHAKE_OVERLAP_PREFIX =
  "/agents/voice/startup-colocated/handshake-overlap/overlap/";
export const VOICE_HANDSHAKE_OVERLAP_URL = "https://api.openai.com/v1/live/sessions";
export const VOICE_HANDSHAKE_OVERLAP_TTL_MS = 10_000;

export const VoiceHandshakeOverlapInput = z.strictObject({
  streamPath: z.string().startsWith(VOICE_HANDSHAKE_OVERLAP_PREFIX),
  activation: z.string().uuid(),
});
export type VoiceHandshakeOverlapInput = z.output<typeof VoiceHandshakeOverlapInput>;

export function assertVoiceHandshakeOverlapScope(input: {
  deploymentEnv: string | undefined;
  projectId: string;
  streamPath: string;
}) {
  if (input.deploymentEnv !== "preview_17") {
    throw new Error("voice handshake overlap control is only enabled in preview_17");
  }
  if (input.projectId !== VOICE_HANDSHAKE_OVERLAP_PROJECT_ID) {
    throw new Error("voice handshake overlap control is only enabled for its proof project");
  }
  if (!input.streamPath.startsWith(VOICE_HANDSHAKE_OVERLAP_PREFIX)) {
    throw new Error("voice handshake overlap control stream path is outside its proof prefix");
  }
}

export function isVoiceHandshakeOverlapRequest(request: Request) {
  return (
    request.method === "GET" &&
    request.url === VOICE_HANDSHAKE_OVERLAP_URL &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    request.headers.get("Authorization") === 'Bearer getSecret("/secrets/openai")'
  );
}
