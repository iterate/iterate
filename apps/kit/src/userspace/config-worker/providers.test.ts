import { WebSocketPair } from "captun";
import { describe, expect, test, vi } from "vitest";
import {
  connectDeterministicTone,
  connectGrokRealtimeVoice,
  GrokCredentialPrewarmer,
  mintGrokRealtimeCredential,
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
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }

  send(data: unknown) {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error("The provider socket was used before accept().");
    }
    this.sent.push(data);
  }
}

describe("userspace PCM providers", () => {
  test("prewarms the single-use Grok credential before opening the provider socket", async () => {
    const requests: Request[] = [];
    const startupStages: string[] = [];
    const credential = await mintGrokRealtimeCredential({
      fetchCredential: async (request) => {
        requests.push(request);
        return Response.json({
          expires_at: Math.ceil(Date.now() / 1_000) + 3_600,
          value: "prewarmed-client-secret",
        });
      },
      onStage: (stage) => startupStages.push(stage.code),
    });

    const socket = new FakeProviderSocket("wss://api.x.ai/v1/realtime");
    const provider = await connectGrokRealtimeVoice({
      createWebSocket: (url, protocols) => {
        expect(url).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0");
        expect(protocols).toEqual(["xai-client-secret.prewarmed-client-secret"]);
        queueMicrotask(() => socket.open());
        /*
         * The fake implements only the WebSocket surface this provider owns;
         * the cast keeps unrelated browser event-handler fields out of a
         * focused protocol test.
         */
        return socket as unknown as WebSocket;
      },
      credential,
      onStage: (stage) => startupStages.push(stage.code),
      sampleRateHz: 16_000,
      turnDetection: "manual",
    });

    expect(provider).toBe(socket);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.x.ai/v1/realtime/client_secrets");
    expect(requests[0]?.headers.get("authorization")).toBe(
      'Bearer getSecret("/secrets/kit/xai-api-key")',
    );
    expect(startupStages).toEqual([
      "credential-prewarm-started",
      "credential-prewarm-received",
      "credential-prewarm-decoded",
      "provider-websocket-created",
      "provider-websocket-opened",
      "session-update-sent",
    ]);
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
          keep_context: true,
          tools: [
            {
              description:
                "Change the active Iterate Kit device display background to red or green.",
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

  test("configures provider-owned VAD explicitly for a continuous AEC session", async () => {
    const socket = new FakeProviderSocket("wss://api.x.ai/v1/realtime");
    await connectGrokRealtimeVoice({
      createWebSocket: () => {
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      credential: {
        expiresAtEpochSeconds: Math.ceil(Date.now() / 1_000) + 3_600,
        value: "server-vad-client-secret",
      },
      sampleRateHz: 16_000,
      serverVadProfile: "low-level-aec",
      turnDetection: "server-vad",
    });

    const update = JSON.parse(String(socket.sent[0])) as {
      session: {
        turn_detection: {
          prefix_padding_ms?: number;
          silence_duration_ms?: number;
          threshold?: number;
          type: string | null;
        };
      };
    };
    /*
     * xAI's documented 0.85 default and our first explicit 0.5 setting both
     * failed to detect a production StackChan prompt. That exact 0.5 run sent
     * 4,930 current PCM frames, reached a device-observed clean peak of 12,670,
     * and retained zero speech_started events. Use 0.2 as the next bounded
     * hardware calibration point; it remains above xAI's documented minimum
     * of 0.1 and avoids hiding the failure behind firmware gain or resampling.
     */
    expect(update.session.turn_detection).toEqual({
      prefix_padding_ms: 400,
      silence_duration_ms: 1_000,
      threshold: 0.1,
      type: "server_vad",
    });
  });

  test("uses the measured VAD floor for HAVPE's low-level pre-AGC tap", async () => {
    /*
     * The prior HAVPE AGC tap made 0.1 turn ordinary background conversation
     * into one 95-second utterance. Moving to NS removed that final ~100x gain;
     * with the unchanged 0.85 threshold, a physical prompt peaked at 557 and
     * produced no speech edge across 4,772 losslessly forwarded frames. Use
     * xAI's documented 0.1 floor for this newly measured low-level contract.
     */
    const socket = new FakeProviderSocket("wss://api.x.ai/v1/realtime");
    await connectGrokRealtimeVoice({
      createWebSocket: () => {
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      credential: {
        expiresAtEpochSeconds: Math.ceil(Date.now() / 1_000) + 3_600,
        value: "xmos-server-vad-client-secret",
      },
      sampleRateHz: 16_000,
      serverVadProfile: "xmos-aec-ns",
      turnDetection: "server-vad",
    });

    const update = JSON.parse(String(socket.sent[0])) as {
      session: { turn_detection: Record<string, unknown> };
    };
    expect(update.session.turn_detection).toEqual({
      prefix_padding_ms: 400,
      silence_duration_ms: 1_000,
      threshold: 0.1,
      type: "server_vad",
    });
  });

  test("replenishes the next single-use credential as soon as one is consumed", async () => {
    /*
     * xAI returns 401 when the same ephemeral credential is used for a second
     * WebSocket. The warm slot therefore has consume-and-refill semantics, not
     * a conventional TTL cache. Starting the refill before the current call
     * proceeds keeps the next Button-B press off the slow credential path.
     */
    let mintCount = 0;
    const prewarmer = new GrokCredentialPrewarmer({
      mintCredential: async () => {
        mintCount += 1;
        return {
          expiresAtEpochSeconds: Math.ceil(Date.now() / 1_000) + 3_600,
          value: `single-use-${mintCount}`,
        };
      },
    });

    await prewarmer.prewarm();
    expect(prewarmer.metrics()).toMatchObject({ attempts: 1, failures: 0, state: "ready" });
    const first = await prewarmer.take();

    expect(first.value).toBe("single-use-1");
    expect(mintCount).toBe(2);
    await prewarmer.prewarm();
    expect(prewarmer.metrics()).toMatchObject({ attempts: 2, failures: 0, state: "ready" });
    prewarmer[Symbol.dispose]();
  });

  test("rejects a newly minted credential that cannot survive the call edge", async () => {
    /*
     * Treating a provider's already-expired value as a cache miss would make
     * `take()` mint forever under a malformed upstream response. Rejecting at
     * the trust boundary keeps recovery finite and leaves the failure visible
     * in prewarmer metrics for a later button press to retry.
     */
    await expect(
      mintGrokRealtimeCredential({
        fetchCredential: async () =>
          Response.json({
            expires_at: Math.floor(Date.now() / 1_000),
            value: "already-expired",
          }),
      }),
    ).rejects.toThrow("expires too soon");
  });

  test("reports a failed prewarm and permits one explicit later retry", async () => {
    let mintCount = 0;
    const failures: string[] = [];
    const prewarmer = new GrokCredentialPrewarmer({
      mintCredential: async () => {
        mintCount += 1;
        if (mintCount === 1) throw new Error("egress unavailable");
        return {
          expiresAtEpochSeconds: Math.ceil(Date.now() / 1_000) + 3_600,
          value: "recovered-single-use",
        };
      },
      onFailure: (error) => failures.push(error instanceof Error ? error.message : String(error)),
    });

    await expect(prewarmer.prewarm()).rejects.toThrow("egress unavailable");
    expect(prewarmer.metrics()).toMatchObject({
      attempts: 1,
      failures: 1,
      lastError: "egress unavailable",
      state: "empty",
    });

    await expect(prewarmer.take()).resolves.toMatchObject({ value: "recovered-single-use" });
    expect(failures).toEqual(["egress unavailable"]);
    expect(prewarmer.metrics()).toMatchObject({ attempts: 3, failures: 1, state: "ready" });
    prewarmer[Symbol.dispose]();
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
