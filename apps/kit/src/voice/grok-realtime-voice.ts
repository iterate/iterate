import { z } from "zod";

const GrokClientSecret = z.strictObject({
  expires_at: z.number().int().positive(),
  value: z.string().min(1).max(512),
});

const supportedPcmSampleRates = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000]);

export type GrokWebSocketFactory = (url: string, protocols: readonly string[]) => WebSocket;

export interface GrokRealtimeVoiceOptions {
  apiKey: string;
  connectTimeoutMs?: number;
  createWebSocket?: GrokWebSocketFactory;
  fetch?: typeof globalThis.fetch;
  instructions?: string;
  model?: string;
  sampleRateHz: number;
  turnDetection?: "manual" | "server-vad";
  voice?: string;
}

const defaultWebSocketFactory: GrokWebSocketFactory = (url, protocols) =>
  new WebSocket(url, [...protocols]);

/**
 * Opens one xAI realtime session configured for raw, headerless PCM16 in both
 * directions. The long-lived API key is used only on the HTTPS egress request
 * that mints a short-lived WebSocket credential.
 */
export async function connectGrokRealtimeVoice(options: GrokRealtimeVoiceOptions) {
  if (!options.apiKey) {
    throw new Error("The Grok server API key is missing.");
  }
  if (!supportedPcmSampleRates.has(options.sampleRateHz)) {
    throw new Error(`Grok does not support ${options.sampleRateHz} Hz PCM audio.`);
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error("The Grok WebSocket timeout must be a positive integer.");
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const credentialResponse = await fetchImplementation(
    "https://api.x.ai/v1/realtime/client_secrets",
    {
      body: JSON.stringify({ expires_after: { seconds: 300 } }),
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  if (!credentialResponse.ok) {
    throw new Error(
      `Grok client credential request failed with status ${credentialResponse.status}.`,
    );
  }

  const parsedCredential = GrokClientSecret.safeParse(await credentialResponse.json());
  if (!parsedCredential.success) {
    throw new Error("Grok returned a malformed client credential.");
  }

  const model = options.model ?? "grok-voice-think-fast-2.0";
  const endpoint = new URL("wss://api.x.ai/v1/realtime");
  endpoint.searchParams.set("model", model);
  const createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
  const socket = createWebSocket(endpoint.href, [
    `xai-client-secret.${parsedCredential.data.value}`,
  ]);
  socket.binaryType = "arraybuffer";

  try {
    await waitForOpen(socket, connectTimeoutMs);
    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              format: {
                rate: options.sampleRateHz,
                type: "audio/pcm",
              },
              transcription: { model: "grok-transcribe" },
              transport: "binary",
            },
            output: {
              format: {
                rate: options.sampleRateHz,
                type: "audio/pcm",
              },
              transport: "binary",
            },
          },
          instructions: options.instructions ?? "Be concise, conversational, and useful.",
          turn_detection: {
            type: options.turnDetection === "manual" ? null : "server_vad",
          },
          voice: options.voice ?? "eve",
        },
      }),
    );
    return socket;
  } catch (error) {
    socket.close(1000, "Grok connection setup failed.");
    throw error;
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Grok WebSocket handshake timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const opened = () => {
      cleanup();
      resolve();
    };
    const errored = () => {
      cleanup();
      reject(new Error("Grok WebSocket handshake failed."));
    };
    const closed = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`Grok WebSocket closed during handshake with code ${event.code}.`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", errored);
      socket.removeEventListener("close", closed);
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", errored, { once: true });
    socket.addEventListener("close", closed, { once: true });
  });
}
