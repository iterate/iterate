import { WebSocketPair } from "captun";
import { describe, expect, test, vi } from "vitest";
import {
  connectDeterministicTone,
  connectGrokRealtimeVoice,
  type AcceptedSocketPair,
} from "./providers.ts";

function unacceptedSocketPair(): AcceptedSocketPair {
  const pair = new WebSocketPair();
  return { first: pair[0], second: pair[1] };
}

class FakeProviderSocket extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState: number = WebSocket.CONNECTING;
  sent: unknown[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  send(data: unknown) {
    this.sent.push(data);
  }
}

describe("userspace PCM providers", () => {
  test("mints a short-lived Grok credential through project egress and configures native PCM16", async () => {
    const requests: Request[] = [];
    let socket: FakeProviderSocket | undefined;
    const provider = await connectGrokRealtimeVoice({
      createWebSocket(url, protocols) {
        expect(protocols).toEqual(["xai-client-secret.short-lived"]);
        socket = new FakeProviderSocket(url);
        return socket as unknown as WebSocket;
      },
      fetchCredential: async (request) => {
        requests.push(request);
        return Response.json({ expires_at: 123_456, value: "short-lived" });
      },
      sampleRateHz: 16_000,
    });

    expect(provider).toBe(socket);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.x.ai/v1/realtime/client_secrets");
    expect(await requests[0]?.json()).toEqual({
      expires_after: { seconds: 3_600 },
    });
    expect(requests[0]?.headers.get("authorization")).toBe(
      'Bearer getSecret("/secrets/kit/xai-api-key")',
    );
    expect(socket?.url).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0");
    expect(socket?.sent).toContainEqual(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              format: { rate: 16_000, type: "audio/pcm" },
              transcription: { model: "grok-transcribe" },
              transport: "binary",
            },
            output: {
              format: { rate: 16_000, type: "audio/pcm" },
              transport: "binary",
            },
          },
          instructions: "Be concise, conversational, and useful.",
          tools: [
            {
              description: "Change the physical M5StickS3 display background to red or green.",
              name: "changeColour",
              parameters: {
                additionalProperties: false,
                properties: {
                  colour: { enum: ["red", "green"], type: "string" },
                },
                required: ["colour"],
                type: "object",
              },
              type: "function",
            },
          ],
          turn_detection: { type: null },
          voice: "eve",
        },
      }),
    );
  });

  test("streams a known tone at media cadence with constant-sized device frames", async () => {
    vi.useFakeTimers();
    /*
     * This pair is intentionally not pre-accepted. Unlike the half returned in
     * a 101 Response, both halves of an entirely internal WebSocketPair need
     * explicit ownership before either can send. Production previously
     * accepted only the renderer half and then failed its first control send.
     */
    const pair = unacceptedSocketPair();
    const messages: unknown[] = [];
    pair.first.addEventListener("message", (event) => messages.push(event.data));
    const provider = await connectDeterministicTone({
      createPair: () => pair,
      durationMs: 40,
      frequencyHz: 1_000,
      sampleRateHz: 16_000,
    });

    provider.send(JSON.stringify({ type: "response.create" }));
    await vi.runAllTimersAsync();

    expect(messages[0]).toBe('{"type":"response.created"}');
    expect(
      messages
        .slice(1, 3)
        .every((message) => ArrayBuffer.isView(message) && message.byteLength === 640),
    ).toBe(true);
    /*
     * The Stick's direct-I2S path deliberately holds the ES8311 codec at
     * -18 dB to avoid the brownout seen at the codec's 0 dB setting. The
     * deterministic provider must therefore use the same 75%-scale source
     * level that the physical direct-LAN harness proved safe and audible.
     * A second software attenuation here used to make a perfectly healthy
     * 100/100/100 production playback run effectively inaudible, so frame
     * size and cadence alone are not a sufficient provider contract.
     */
    const firstPcmFrame = messages[1];
    expect(ArrayBuffer.isView(firstPcmFrame)).toBe(true);
    if (!ArrayBuffer.isView(firstPcmFrame)) {
      throw new Error("The deterministic provider did not emit a typed PCM frame.");
    }
    const firstPcmSamples = new DataView(
      firstPcmFrame.buffer,
      firstPcmFrame.byteOffset,
      firstPcmFrame.byteLength,
    );
    expect(firstPcmSamples.getInt16(4 * Int16Array.BYTES_PER_ELEMENT, true)).toBe(24_576);
    expect(messages[3]).toBe('{"type":"response.done"}');
    provider.close();
    vi.useRealTimers();
  });

  test("acknowledges a manual input commit before accepting the response request", async () => {
    vi.useFakeTimers();
    /*
     * Deterministic mode is a provider substitute, not a shortcut around the
     * userspace turn state machine. A physical PTT release first commits the
     * live microphone buffer; PcmSessionBridge deliberately waits for this
     * acknowledgement before sending response.create. Without the matching
     * mock event, boot-time audio could appear healthy while every later PTT
     * turn remained permanently silent—the exact production failure this test
     * records.
     */
    const pair = unacceptedSocketPair();
    const messages: unknown[] = [];
    pair.first.addEventListener("message", (event) => messages.push(event.data));
    const provider = await connectDeterministicTone({
      createPair: () => pair,
      durationMs: 20,
      frequencyHz: 1_000,
      sampleRateHz: 16_000,
    });

    provider.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toEqual(['{"type":"input_audio_buffer.committed"}']);

    provider.send(JSON.stringify({ type: "response.create" }));
    await vi.runAllTimersAsync();
    expect(messages.at(-1)).toBe('{"type":"response.done"}');
    provider.close();
    vi.useRealTimers();
  });
});
