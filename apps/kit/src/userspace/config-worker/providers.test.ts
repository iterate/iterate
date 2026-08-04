import { WebSocketPair } from "captun";
import { describe, expect, test, vi } from "vitest";
import {
  connectDeterministicAec,
  connectDeterministicTone,
  connectGrokRealtimeVoice,
  GrokCredentialPrewarmer,
  mintGrokRealtimeCredential,
  type AcceptedSocketPair,
} from "./providers.ts";
import { createDeterministicAecRenderer } from "./deterministic-aec-fixture.ts";

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
              transcription: { language_hint: "en", model: "grok-transcribe" },
              transport: "binary",
            },
            output: {
              format: { rate: 16_000, type: "audio/pcm" },
              transport: "binary",
            },
          },
          instructions:
            "Be concise, conversational, useful, and pleasantly decisive. Wait silently until the user speaks. Respond to the user's complete request, including the first turn; never replace a concrete request with a generic greeting. Prefer taking a safe, reversible action over asking a follow-up question or requesting permission. Use good judgment, make reasonable choices, and occasionally surprise the user in a delightful way; ask a question only when a missing answer materially changes the outcome or safety. If a short opening is ambiguous, treat it as a greeting and ask how you can help. Never infer a face, avatar, sprite, gesture, or hang-up from unrelated words. When the user explicitly asks to change the face, avatar, or sprite without naming one, choose an appropriate supported sprite set yourself and call changeSpriteSet instead of asking which one. On StackChan, accompany a clearly affirmative or agreeing spoken answer with the nod tool, and accompany a clearly negative, disagreeing, or refusing spoken answer with the shakeHead tool; do both naturally without announcing the gesture. For example, if the user asks “Are you there?”, call nod and say “Yes, I’m here.” Do not gesture for quoted, hypothetical, or ambiguous yes/no language. Also obey an explicit gesture request. If the user says stop, pause, be quiet, or otherwise interrupts while you are speaking, stop that reply and remain in the conversation; do not call endConversation. Call endConversation only when the user explicitly asks to end the conversation, hang up, or go back to sleep; treat “go back to sleep” as an explicit hang-up, optionally give a brief sign-off, call endConversation, and do not ask for confirmation. Do not list tools or sprite sets unless the user asks. Do not claim a physical action succeeded until its tool result says it did.",
          keep_context: true,
          tools: [
            {
              description:
                "Change the active Iterate Kit device to one of its compiled sprite sets. " +
                "When the user requests a face change without naming one, choose a suitable set yourself. " +
                "Spoken names map as follows: Dot Matrix Oracle to dot-matrix-oracle; " +
                "Karakuri Brass to karakuri-brass; Star Byte to starbyte.",
              name: "changeSpriteSet",
              parameters: {
                additionalProperties: false,
                properties: {
                  spriteSet: {
                    enum: ["dot-matrix-oracle", "karakuri-brass", "starbyte"],
                    type: "string",
                  },
                },
                required: ["spriteSet"],
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

  test("offers StackChan's bounded physical gestures and hang-up without exposing ITX", async () => {
    const socket = new FakeProviderSocket("wss://api.x.ai/v1/realtime");
    await connectGrokRealtimeVoice({
      createWebSocket: () => {
        queueMicrotask(() => socket.open());
        return socket as unknown as WebSocket;
      },
      credential: {
        expiresAtEpochSeconds: Math.ceil(Date.now() / 1_000) + 3_600,
        value: "stackchan-tool-secret",
      },
      deviceId: "stackchan",
      sampleRateHz: 16_000,
      serverVadProfile: "low-level-aec",
      turnDetection: "server-vad",
    });

    const update = JSON.parse(String(socket.sent[0])) as {
      session: {
        tools: Array<{
          description: string;
          name: string;
          parameters: unknown;
        }>;
      };
    };
    expect(update.session.tools.map((tool) => tool.name)).toEqual([
      "changeSpriteSet",
      "endConversation",
      "nod",
      "shakeHead",
    ]);
    expect(update.session.tools.slice(1).map((tool) => tool.parameters)).toEqual([
      { additionalProperties: false, properties: {}, type: "object" },
      { additionalProperties: false, properties: {}, type: "object" },
      { additionalProperties: false, properties: {}, type: "object" },
    ]);
    /*
     * These examples are behavioral policy, not decoration: vague gesture and
     * lifecycle descriptions previously led the model to answer verbally but
     * omit the physical action, or ask permission before honoring “sleep”.
     */
    expect(update.session.tools[1]?.description).toContain("go back to sleep");
    expect(update.session.tools[1]?.description).toContain("Do not ask for confirmation");
    expect(update.session.tools[2]?.description).toContain("Are you there?");
    expect(update.session.tools[2]?.description).toContain("Yes, I’m here.");
  });

  test("uses the shared 400 ms endpoint policy for StackChan", async () => {
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
     * A provider threshold cannot distinguish assistant echo from double-talk:
     * physical 0.1 false-triggered on echo, while 0.2 missed real barge-in.
     * Keep the near-speech-sensitive floor and require the device AEC plus the
     * speaker-only semantic oracle to remove self-talk before this boundary.
     *
     * Endpoint latency is a product contract shared by every continuous-AEC
     * target. Signal profiles remain named because gain and DSP provenance
     * differ, but they must not silently create different conversational UX.
     */
    expect(update.session.turn_detection).toEqual({
      prefix_padding_ms: 400,
      silence_duration_ms: 400,
      threshold: 0.1,
      type: "server_vad",
    });
  });

  test("keeps HAVPE's AEC tap at the measured low-level server-VAD floor", async () => {
    /*
     * The prior HAVPE AGC tap made 0.1 turn ordinary background conversation
     * into one 95-second utterance. Fixed-gain downstream taps removed that
     * amplification, but ×16 userspace gain later made first-convergence
     * residue open false turns in two count proofs. The current firmware uses
     * XMOS's AEC tap because the matched-path oracle found negligible speaker
     * leakage and better near-speech preservation than IC/NS. Keep the next
     * bounded ladder rung at ×8 and xAI's supported 0.1 floor. The 500 ms
     * endpoint tail is independent: it affects when a real turn closes, not
     * whether echo opens one.
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
      serverVadProfile: "xmos-aec",
      turnDetection: "server-vad",
    });

    const update = JSON.parse(String(socket.sent[0])) as {
      session: { turn_detection: Record<string, unknown> };
    };
    expect(update.session.turn_detection).toEqual({
      prefix_padding_ms: 400,
      silence_duration_ms: 400,
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

  test("streams the quiet ordered AEC sources through the same provider protocol", async () => {
    vi.useFakeTimers();
    const pair = unacceptedSocketPair();
    const messages: unknown[] = [];
    pair.first.addEventListener("message", (event) => messages.push(event.data));
    const provider = await connectDeterministicAec({ createPair: () => pair });

    provider.send(JSON.stringify({ type: "response.create" }));
    await vi.runAllTimersAsync();
    expect(messages[0]).toBe('{"type":"response.created"}');
    expect(messages[1]).toEqual(createDeterministicAecRenderer(0).render(320));
    expect(messages.at(-1)).toBe('{"type":"response.done"}');

    const secondResponseStart = messages.length;
    provider.send(JSON.stringify({ type: "response.create" }));
    await vi.runAllTimersAsync();
    expect(messages[secondResponseStart]).toBe('{"type":"response.created"}');
    expect(messages[secondResponseStart + 1]).toEqual(
      createDeterministicAecRenderer(1).render(320),
    );
    expect(messages.at(-1)).toBe('{"type":"response.done"}');
    provider.close();
    vi.useRealTimers();
  });
});
