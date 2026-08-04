import { WebSocketPair } from "captun";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ITERATE_KIT_PCM_FRAME_BYTES,
  PcmSessionBridge,
  type ProviderFunctionCall,
  type ProviderNonPcmEvent,
  type PcmProxyDiagnostic,
} from "./pcm-proxy.ts";

type AcceptingWebSocket = WebSocket & { accept(): void };

interface SocketPair {
  client: WebSocket;
  server: WebSocket;
}

function socketPair(): SocketPair {
  const pair = new WebSocketPair();
  const client = pair[0] as AcceptingWebSocket;
  const server = pair[1] as AcceptingWebSocket;
  client.accept();
  server.accept();
  client.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  return { client, server };
}

function binaryMessages(socket: WebSocket) {
  const messages: Uint8Array[] = [];
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      messages.push(new Uint8Array(event.data));
    } else if (ArrayBuffer.isView(event.data)) {
      messages.push(
        new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength),
      );
    }
  });
  return messages;
}

function binaryMessageBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (!ArrayBuffer.isView(data)) return undefined;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function downlinkReceipt(releasedItems: number): Uint8Array {
  const receipt = Uint8Array.of(0x49, 0x4b, 0x41, 1, 0, 0, 0, 0);
  new DataView(receipt.buffer).setUint32(4, releasedItems, true);
  return receipt;
}

function acknowledgeEveryDownlinkItem(socket: WebSocket): void {
  let releasedItems = 0;
  socket.addEventListener("message", (event) => {
    const bytes = binaryMessageBytes(event.data);
    if (
      bytes === undefined ||
      (bytes.byteLength !== 0 && bytes.byteLength !== ITERATE_KIT_PCM_FRAME_BYTES)
    ) {
      return;
    }
    /*
     * Production firmware acknowledges only after its hardware-clocked
     * playback consumer releases the complete ordered item. Captun has no DAC,
     * so this default fixture models zero-latency consumption at MessageEvent.
     * Timing and flow-control cases disable it and emit receipts from an
     * explicit fake hardware clock; unrelated protocol cases stay concise.
     */
    releasedItems += 1;
    socket.send(downlinkReceipt(releasedItems));
  });
}

function textMessages(socket: WebSocket) {
  const messages: string[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") messages.push(event.data);
  });
  return messages;
}

describe("userspace PCM session bridge", () => {
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
    vi.useRealTimers();
  });

  function createBridge(
    options: {
      automaticDownlinkReceipts?: boolean;
      downlinkSourceStartupFrames?: number;
      onAcceptedUplinkPcm?: (frame: Uint8Array, acceptedUplinkFrame: number) => void;
      onPlaybackInterruption?: () => Promise<void> | void;
      onProviderEvent?: (event: ProviderNonPcmEvent) => void;
      onProviderFunctionCall?: (call: ProviderFunctionCall) => Promise<unknown>;
      onProviderUnavailable?: () => void;
      turnDetection?: "manual" | "server-vad";
      uplinkGainMultiplier?: number;
    } = {},
  ) {
    const device = socketPair();
    const provider = socketPair();
    sockets.push(device.client, device.server, provider.client, provider.server);
    const diagnostics: PcmProxyDiagnostic[] = [];
    if (options.automaticDownlinkReceipts !== false) {
      acknowledgeEveryDownlinkItem(device.client);
    }
    const bridge = new PcmSessionBridge({
      device: device.server,
      downlinkSourceStartupFrames: options.downlinkSourceStartupFrames,
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 16,
      onAcceptedUplinkPcm: options.onAcceptedUplinkPcm,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onPlaybackInterruption: options.onPlaybackInterruption,
      onProviderEvent: options.onProviderEvent,
      onProviderFunctionCall: options.onProviderFunctionCall,
      onProviderUnavailable: options.onProviderUnavailable,
      sessionId: "prj_test",
      /*
       * Most bridge tests inject provider-owned response media directly and
       * therefore model server VAD. Manual PTT tests opt in explicitly and
       * must traverse commit acknowledgement -> response.create before Grok
       * is permitted to speak. Making that distinction visible prevents a
       * convenient fixture from weakening the physical silent-start contract.
       */
      turnDetection: options.turnDetection ?? "server-vad",
      ...(options.uplinkGainMultiplier === undefined
        ? {}
        : { uplinkGainMultiplier: options.uplinkGainMultiplier }),
    });
    bridge.setConversationActive(true);
    expect(bridge.attachProvider(provider.server)).toBe(true);
    return { bridge, device, diagnostics, provider };
  }

  test("exposes every non-PCM provider frame verbatim without forwarding it to the device", async () => {
    /*
     * Transcriptions and provider errors are evidence, not audio. The public
     * callback must retain the exact wire text so the production harness can
     * distinguish what Grok actually said from a later parser's summary,
     * while the dedicated device lane remains binary-only.
     */
    const events: ProviderNonPcmEvent[] = [];
    const { device, provider } = createBridge({
      onProviderEvent: (event) => events.push(event),
    });
    const downlink = textMessages(device.client);
    const raw =
      '{"type":"conversation.item.input_audio_transcription.updated","transcript":"web socket failed"}';

    provider.client.send(raw);

    await vi.waitFor(() =>
      expect(events).toEqual([
        {
          event: {
            transcript: "web socket failed",
            type: "conversation.item.input_audio_transcription.updated",
          },
          raw,
          type: "conversation.item.input_audio_transcription.updated",
        },
      ]),
    );
    expect(downlink).toEqual([]);
  });

  test("answers xAI application keepalives while preserving the raw provider event", async () => {
    /*
     * xAI's realtime service uses a JSON keepalive in addition to normal
     * WebSocket ping/pong frames. The official xAI clients copy the incoming
     * `timestamp` into a `pong.ping_timestamp`. The physical StackChan exposed
     * that our bridge was silently omitting this provider-protocol response.
     * A later 1006 still occurred after correct pongs, so this test deliberately
     * proves only protocol compatibility; it does not misattribute every socket
     * retirement to a missing pong. This belongs at the provider socket boundary:
     * neither the device PCM lane nor Cap'n Web should know it exists.
     */
    const events: ProviderNonPcmEvent[] = [];
    const { bridge, device, provider } = createBridge({
      onProviderEvent: (event) => events.push(event),
    });
    const providerCommands = textMessages(provider.client);
    const deviceCommands = textMessages(device.client);
    const raw = '{"type":"ping","event_id":"evt_keepalive","timestamp":1785556000123}';

    provider.client.send(raw);

    await vi.waitFor(() =>
      expect(providerCommands.map((message) => JSON.parse(message) as unknown)).toEqual([
        { ping_timestamp: 1_785_556_000_123, type: "pong" },
      ]),
    );
    expect(events).toEqual([
      {
        event: {
          event_id: "evt_keepalive",
          timestamp: 1_785_556_000_123,
          type: "ping",
        },
        raw,
        type: "ping",
      },
    ]);
    expect(deviceCommands).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      providerKeepalivePings: 1,
      providerKeepalivePongs: 1,
    });
  });

  test("relays each microphone frame immediately and preserves rechunked provider audio", async () => {
    const { bridge, device, provider } = createBridge();
    const uplink = binaryMessages(provider.client);
    const downlink = binaryMessages(device.client);
    const microphoneFrame = Uint8Array.from(
      { length: ITERATE_KIT_PCM_FRAME_BYTES },
      (_, index) => index % 251,
    );

    device.client.send(microphoneFrame);
    await vi.waitFor(() => expect(uplink).toHaveLength(1));
    expect(uplink[0]).toEqual(microphoneFrame);
    provider.client.send(microphoneFrame.slice(0, 117));
    provider.client.send(microphoneFrame.slice(117));
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(downlink).toHaveLength(2));
    expect(downlink[0]).toEqual(microphoneFrame);
    expect(downlink[1]).toHaveLength(0);
  });

  test("observes only the gained microphone frame accepted by the provider socket", async () => {
    /*
     * The production AEC capture must represent what Grok actually received,
     * including the configured userspace gain. Observation before send would
     * let a rejected frame masquerade as evidence; retaining the MessageEvent
     * view would let the next owner mutate evidence after the callback. The
     * recorder is therefore called synchronously after send and owns copying.
     */
    const accepted: Array<{ frame: Uint8Array; ordinal: number }> = [];
    const { device, provider } = createBridge({
      onAcceptedUplinkPcm: (frame, ordinal) => accepted.push({ frame: frame.slice(), ordinal }),
      uplinkGainMultiplier: 2,
    });
    const providerFrames = binaryMessages(provider.client);
    const frame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES);
    new DataView(frame.buffer).setInt16(0, 1_000, true);
    const secondFrame = frame.slice();

    device.client.send(frame);
    device.client.send(secondFrame);

    await vi.waitFor(() => expect(accepted).toHaveLength(2));
    expect(accepted.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(new DataView(accepted[0]!.frame.buffer).getInt16(0, true)).toBe(2_000);
    await vi.waitFor(() =>
      expect(providerFrames).toEqual(accepted.map(({ frame: acceptedFrame }) => acceptedFrame)),
    );
  });

  test("admits only one explicit diagnostic response until its physical boundary drains", async () => {
    /*
     * The deployed AEC rig needs known far-end audio without pretending that
     * a mock provider implemented speech detection. This request still crosses
     * the real provider control seam and the ordinary paced device downlink.
     * The one-at-a-time fence is the important regression: two closely spaced
     * harness calls must not manufacture overlapping responses or hide audio
     * behind an unbounded provider/runtime queue.
     */
    const { bridge, device, provider } = createBridge();
    const controls = textMessages(provider.client);
    const downlink = binaryMessages(device.client);
    const answer = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(47);

    expect(bridge.requestDiagnosticResponse()).toBe(true);
    expect(bridge.requestDiagnosticResponse()).toBe(false);
    await vi.waitFor(() => expect(controls).toEqual(['{"type":"response.create"}']));

    provider.client.send(JSON.stringify({ type: "response.created" }));
    expect(bridge.requestDiagnosticResponse()).toBe(false);
    provider.client.send(answer);
    provider.client.send(JSON.stringify({ type: "response.done" }));

    await vi.waitFor(() => expect(downlink).toEqual([answer, new Uint8Array(0)]));
    expect(bridge.metrics()).toMatchObject({
      diagnosticResponseRequests: 1,
      providerResponsesCompleted: 1,
    });
    expect(bridge.requestDiagnosticResponse()).toBe(true);
    await vi.waitFor(() =>
      expect(controls).toEqual(['{"type":"response.create"}', '{"type":"response.create"}']),
    );
  });

  test("rejects explicit diagnostic responses on a manual PTT session", async () => {
    /*
     * A diagnostic seam must not become a second way to make the Stick speak
     * without a completed physical PTT turn. Tone injection is for the two
     * continuous-AEC targets; manual mode retains its stricter commit fence.
     */
    const { bridge, provider } = createBridge({ turnDetection: "manual" });
    const controls = textMessages(provider.client);

    expect(bridge.requestDiagnosticResponse()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toEqual([]);
    expect(bridge.metrics().diagnosticResponseRequests).toBe(0);
  });

  test("measures the provider PCM source and counts completed responses", async () => {
    /*
     * An acoustic miss can originate before the Stick (quiet provider PCM) or
     * after it (codec, speaker, or capture geometry). Transport counters alone
     * cannot distinguish those cases. These streaming aggregates retain no
     * conversation audio, yet give a production proof an exact source-level
     * attribution and a response boundary it can wait for before hanging up.
     * Splitting one sample across WebSocket messages protects the measurement
     * from accidentally treating provider packetization as PCM framing.
     */
    const { bridge, provider } = createBridge();
    const pcm = Uint8Array.of(
      0x18,
      0xfc, // -1000
      0xd0,
      0x07, // 2000
      0x00,
      0x00, // 0
    );

    provider.client.send(pcm.subarray(0, 3));
    provider.client.send(pcm.subarray(3));
    provider.client.send(JSON.stringify({ type: "response.done" }));

    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        providerPcmPeakSample: 2_000,
        providerPcmSamples: 3,
        providerResponseActive: false,
        providerResponsesCompleted: 1,
      }),
    );
    expect(bridge.metrics().providerPcmRmsSample).toBeCloseTo(
      Math.sqrt((1_000 ** 2 + 2_000 ** 2) / 3),
      8,
    );
  });

  test("measures the exact microphone PCM accepted by the provider lane", async () => {
    /*
     * A server-VAD miss is otherwise ambiguous: continuously advancing frame
     * counters prove transport activity but cannot distinguish silence from
     * useful speech. Measure at the final userspace boundary before Grok, not
     * by retaining audio or adding a second queue. This regression uses signed
     * little-endian edge values so byte order and negative-sample magnitude
     * cannot accidentally pass through a positive-only implementation.
     */
    const { bridge, device, provider } = createBridge({ turnDetection: "server-vad" });
    const uplink = binaryMessages(provider.client);
    const frame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES);
    frame.set([
      0x18,
      0xfc, // -1000
      0xd0,
      0x07, // 2000
      0x00,
      0x00, // 0
    ]);

    device.client.send(frame);

    await vi.waitFor(() => expect(uplink).toEqual([frame]));
    expect(bridge.metrics()).toMatchObject({
      devicePcmPeakSample: 2_000,
      devicePcmSamples: ITERATE_KIT_PCM_FRAME_BYTES / 2,
      uplinkFrames: 1,
    });
    expect(bridge.metrics().devicePcmRmsSample).toBeCloseTo(
      Math.sqrt((1_000 ** 2 + 2_000 ** 2) / (ITERATE_KIT_PCM_FRAME_BYTES / 2)),
      8,
    );
  });

  test("applies calibrated uplink gain without hiding the device level or clipping", async () => {
    /*
     * HAVPE's XMOS noise-suppressed tap is clean enough for full-duplex use,
     * but the physical production run measured a speech peak of only 581.
     * Grok emitted no VAD edge even at its supported 0.1 floor. Restoring the
     * adaptive AGC would also restore the measured speaker-echo retrigger, so
     * the bridge instead applies one fixed, reviewable gain directly in the
     * no-queue send path. This case protects three attribution invariants: the
     * raw device level survives for hardware diagnosis, the exact provider-
     * bound samples are measurable, and saturation can never masquerade as a
     * healthy loud signal.
     */
    const { bridge, device, provider } = createBridge({
      turnDetection: "server-vad",
      uplinkGainMultiplier: 16,
    });
    const uplink = binaryMessages(provider.client);
    const frame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES);
    const samples = new Int16Array(frame.buffer);
    samples.set([-1_000, 2_000, 3_000]);

    device.client.send(frame);

    await vi.waitFor(() => expect(uplink).toHaveLength(1));
    expect([...new Int16Array(uplink[0]!.buffer).slice(0, 4)]).toEqual([
      -16_000, 32_000, 32_767, 0,
    ]);
    expect(bridge.metrics()).toMatchObject({
      devicePcmPeakSample: 3_000,
      devicePcmSamples: ITERATE_KIT_PCM_FRAME_BYTES / 2,
      uplinkGainMultiplier: 16,
      uplinkPcmClippedSamples: 1,
      uplinkPcmPeakSample: 32_767,
      uplinkPcmSamples: ITERATE_KIT_PCM_FRAME_BYTES / 2,
      uplinkFrames: 1,
    });
    expect(bridge.metrics().devicePcmRmsSample).toBeCloseTo(
      Math.sqrt((1_000 ** 2 + 2_000 ** 2 + 3_000 ** 2) / (ITERATE_KIT_PCM_FRAME_BYTES / 2)),
      8,
    );
    expect(bridge.metrics().uplinkPcmRmsSample).toBeCloseTo(
      Math.sqrt((16_000 ** 2 + 32_000 ** 2 + 32_767 ** 2) / (ITERATE_KIT_PCM_FRAME_BYTES / 2)),
      8,
    );
  });

  test("does not mistake a cancelled provider response for completed speech", async () => {
    /*
     * Production Grok emitted a cancelled response.done immediately before
     * response.created for the actual answer. Counting that terminal event as
     * completed woke the physical harness, which hung up while the real reply
     * was still reaching the Stick. A cancellation with no PCM is neither an
     * audible answer nor a device response boundary: it must remain visible in
     * metrics without emitting an empty PCM marker or satisfying the completion
     * predicate. The following genuinely completed response must still play
     * normally, proving that classification does not poison the next response.
     */
    const { bridge, device, provider } = createBridge();
    const downlink = binaryMessages(device.client);
    provider.client.send(
      JSON.stringify({ response: { id: "cancelled", status: "cancelled" }, type: "response.done" }),
    );

    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        providerResponsesCancelled: 1,
        providerResponsesCompleted: 0,
      }),
    );
    expect(downlink).toEqual([]);

    provider.client.send(
      JSON.stringify({
        response: { id: "spoken", status: "in_progress" },
        type: "response.created",
      }),
    );
    provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(23));
    provider.client.send(
      JSON.stringify({ response: { id: "spoken", status: "completed" }, type: "response.done" }),
    );

    await vi.waitFor(() => expect(downlink).toHaveLength(2));
    expect(downlink[0]).toEqual(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(23));
    expect(downlink[1]).toHaveLength(0);
    expect(bridge.metrics()).toMatchObject({
      providerResponsesCancelled: 1,
      providerResponsesCompleted: 1,
    });
  });

  test("pads only the final provider fragment and emits the zero-length response boundary", async () => {
    const { device, provider } = createBridge();
    const downlink = binaryMessages(device.client);
    provider.client.send(Uint8Array.of(1, 2, 3, 4));
    provider.client.send(JSON.stringify({ type: "response.done" }));

    await vi.waitFor(() => expect(downlink).toHaveLength(2));
    expect(downlink[0]).toHaveLength(ITERATE_KIT_PCM_FRAME_BYTES);
    expect([...downlink[0]!.slice(0, 5)]).toEqual([1, 2, 3, 4, 0]);
    expect(downlink[1]).toHaveLength(0);
  });

  test("interruption drops stale partial playback before cancelling the provider", async () => {
    const { bridge, device, provider } = createBridge({ turnDetection: "manual" });
    const controls = textMessages(provider.client);
    const downlink = binaryMessages(device.client);
    /*
     * This response must be authorized exactly as it is on the Stick. Seeding
     * provider PCM directly used to make the test accidentally bless speech
     * at call-open—the bug this interruption path now has to reject.
     */
    expect(bridge.inputStarted()).toBe(true);
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(5));
    expect(bridge.inputStopped()).toBe(true);
    device.client.send(new Uint8Array(0));
    await vi.waitFor(() => expect(controls).toEqual(['{"type":"input_audio_buffer.commit"}']));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await vi.waitFor(() => expect(controls).toContain('{"type":"response.create"}'));
    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(
      JSON.stringify({
        item: { id: "manual-item", role: "assistant", type: "message" },
        type: "response.output_item.added",
      }),
    );
    provider.client.send(
      JSON.stringify({
        content_index: 0,
        item_id: "manual-item",
        part: { type: "audio" },
        type: "response.content_part.added",
      }),
    );
    provider.client.send(new Uint8Array(300).fill(7));
    await vi.waitFor(() => expect(bridge.metrics()).toMatchObject({ downlinkPartialBytes: 300 }));

    /*
     * The PCM lane, not the independently scheduled Cap'n Web callback, owns
     * the instant at which speech actually begins. Exercising a real media
     * frame here prevents this test from blessing the production race where a
     * late button callback used to leave audible provider bytes undisturbed.
     */
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(11));
    await vi.waitFor(() => expect(controls).toContain('{"type":"response.cancel"}'));
    expect(controls.map((message) => JSON.parse(message) as unknown)).toContainEqual({
      audio_end_ms: 0,
      content_index: 0,
      item_id: "manual-item",
      type: "conversation.item.truncate",
    });
    provider.client.send(
      JSON.stringify({
        audio_end_ms: 0,
        content_index: 0,
        item_id: "manual-item",
        type: "conversation.item.truncated",
      }),
    );
    expect(bridge.metrics()).toMatchObject({
      downlinkPartialBytes: 0,
      interrupted: true,
    });

    provider.client.send(new Uint8Array(340).fill(9));
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(downlink).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      providerUnsolicitedPcmBytes: 340,
      providerUnsolicitedResponses: 1,
    });
  });

  test("server VAD does not reset an idle physical playback reference", async () => {
    /*
     * HAVPE feeds its XMOS AEC reference from the physical playback I2S bus.
     * Grok emits speech_started for the first caller utterance while the
     * speaker is necessarily idle. Resetting hardware at that edge cannot
     * discard any stale assistant sample, but it does stop/restart the AEC
     * reference clock immediately before the first reply. A retained physical
     * incident then showed raw ~= clean during that reply and Grok detected
     * the echo as a second caller turn. The semantic interruption state still
     * advances here; only the provably unnecessary physical purge is skipped.
     */
    const interruptPlayback = vi.fn();
    const { bridge, provider } = createBridge({
      onPlaybackInterruption: interruptPlayback,
      turnDetection: "server-vad",
    });

    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));

    await vi.waitFor(() => expect(bridge.metrics().providerSpeechStarts).toBe(1));
    expect(interruptPlayback).not.toHaveBeenCalled();
    expect(bridge.metrics()).toMatchObject({
      interrupted: true,
      playbackInterruptionPending: false,
      playbackInterruptionsRequested: 0,
    });
  });

  test("server VAD streams continuously and owns interruption without manual controls", async () => {
    /*
     * StackChan's AEC output is a continuous provider input, not a sequence of
     * device-committed turns. A tempting reuse of the PTT path would cancel on
     * the first mic frame and then emit commit/response.create at hang-up. The
     * xAI contract instead announces speech_started, cancels its own active
     * response, and later creates the answer after speech_stopped. This test
     * proves that exact public socket sequence, including the one callback that
     * lets the worker flush already-admitted speaker audio on the device.
     */
    let acknowledgePlaybackReset: (() => void) | undefined;
    const interruptPlayback = vi.fn(
      () => new Promise<void>((resolve) => (acknowledgePlaybackReset = resolve)),
    );
    const { bridge, device, provider } = createBridge({
      onPlaybackInterruption: interruptPlayback,
      turnDetection: "server-vad",
    });
    const controls = textMessages(provider.client);
    const uplink = binaryMessages(provider.client);
    const downlink = binaryMessages(device.client);
    const microphoneFrame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(53);
    const freshResponse = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(71);

    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(new Uint8Array(300).fill(7));
    await vi.waitFor(() => expect(bridge.metrics().downlinkPartialBytes).toBe(300));

    device.client.send(microphoneFrame);
    await vi.waitFor(() => expect(uplink).toEqual([microphoneFrame]));
    expect(controls).toEqual([]);
    expect(bridge.metrics().downlinkPartialBytes).toBe(300);

    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    await vi.waitFor(() => expect(interruptPlayback).toHaveBeenCalledOnce());
    expect(controls).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      downlinkDroppedBytes: 300,
      downlinkInterruptedBytes: 300,
      downlinkPartialBytes: 0,
      interrupted: true,
      providerSpeechStarts: 1,
    });

    provider.client.send(
      JSON.stringify({ response: { status: "cancelled" }, type: "response.done" }),
    );
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(freshResponse);
    provider.client.send(
      JSON.stringify({ response: { status: "completed" }, type: "response.done" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(downlink.filter((frame) => frame.byteLength > 0)).toEqual([]);
    acknowledgePlaybackReset?.();

    await vi.waitFor(() =>
      expect(downlink.filter((frame) => frame.byteLength > 0)).toEqual([freshResponse]),
    );
    expect(controls).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      interrupted: false,
      providerCommitMessagesSent: 0,
      providerResponseCreateMessagesSent: 0,
      providerSpeechStarts: 1,
      providerSpeechStops: 1,
      uplinkFrames: 1,
    });
  });

  test("truncates Grok history to hardware-played audio before admitting a barge-in reply", async () => {
    /*
     * Cancelling generation and clearing our speaker queues are not enough:
     * Grok otherwise keeps the transcript for words that were generated but
     * never reached the DAC. That makes its next answer depend on a private
     * continuation the person did not hear. The only authoritative duration
     * is therefore the content whose ordered slots the device hardware has
     * released before speech_started. Bytes merely received from Grok, held in
     * userspace, sent to the ESP, or bulk-released by the subsequent physical
     * reset must not extend conversation history.
     */
    let acknowledgePlaybackReset: (() => void) | undefined;
    const interruptPlayback = vi.fn(
      () => new Promise<void>((resolve) => (acknowledgePlaybackReset = resolve)),
    );
    const { bridge, device, provider } = createBridge({
      automaticDownlinkReceipts: false,
      onPlaybackInterruption: interruptPlayback,
      turnDetection: "server-vad",
    });
    const controls = textMessages(provider.client);
    const downlink = binaryMessages(device.client);

    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(
      JSON.stringify({
        item: {
          id: "assistant-item-1",
          object: "realtime.item",
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 0,
        response_id: "response-1",
        type: "response.output_item.added",
      }),
    );
    provider.client.send(
      JSON.stringify({
        content_index: 0,
        item_id: "assistant-item-1",
        output_index: 0,
        part: { transcript: "", type: "audio" },
        response_id: "response-1",
        type: "response.content_part.added",
      }),
    );
    provider.client.send(new Uint8Array(32 * ITERATE_KIT_PCM_FRAME_BYTES).fill(71));

    await vi.waitFor(() => expect(downlink).toHaveLength(16));
    device.client.send(downlinkReceipt(7));
    await vi.waitFor(() => expect(bridge.metrics().downlinkItemsAcknowledged).toBe(7));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));

    await vi.waitFor(() =>
      expect(controls.map((message) => JSON.parse(message) as unknown)).toContainEqual({
        audio_end_ms: 140,
        content_index: 0,
        item_id: "assistant-item-1",
        type: "conversation.item.truncate",
      }),
    );
    expect(controls).not.toContain('{"type":"response.cancel"}');
    expect(interruptPlayback).toHaveBeenCalledOnce();
    const downlinkItemsAtInterruption = downlink.length;
    expect(downlinkItemsAtInterruption).toBe(23);
    expect(bridge.metrics()).toMatchObject({
      providerTruncationsCompleted: 0,
      providerTruncationsPending: 1,
      providerTruncationsRequested: 1,
    });

    /*
     * A reset receipt can release the nine unplayed DMA slots, but the frozen
     * 140 ms provider duration must not move. Fresh response bytes remain
     * fenced until both independent authorities agree: the device has purged
     * physical playback and xAI has corrected conversation history.
     */
    device.client.send(downlinkReceipt(downlinkItemsAtInterruption));
    acknowledgePlaybackReset?.();
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(
      JSON.stringify({
        item: {
          id: "assistant-item-2",
          object: "realtime.item",
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 0,
        response_id: "response-2",
        type: "response.output_item.added",
      }),
    );
    provider.client.send(
      JSON.stringify({
        content_index: 0,
        item_id: "assistant-item-2",
        output_index: 0,
        part: { transcript: "", type: "audio" },
        response_id: "response-2",
        type: "response.content_part.added",
      }),
    );
    provider.client.send(new Uint8Array(32 * ITERATE_KIT_PCM_FRAME_BYTES).fill(83));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(downlink).toHaveLength(downlinkItemsAtInterruption);

    provider.client.send(
      JSON.stringify({
        audio_end_ms: 140,
        content_index: 0,
        item_id: "assistant-item-1",
        type: "conversation.item.truncated",
      }),
    );
    await vi.waitFor(() => expect(downlink.length).toBeGreaterThan(downlinkItemsAtInterruption));
    expect(bridge.metrics()).toMatchObject({
      providerTruncationsCompleted: 1,
      providerTruncationsPending: 0,
      providerTruncationsRequested: 1,
    });
  });

  test("retires a server-VAD provider that violates automatic response creation", async () => {
    /*
     * Current xAI Voice says response creation is automatic with server VAD.
     * Sending our own response.create after an arbitrary grace period races a
     * late automatic response and can produce two assistant turns. A committed
     * utterance that stays silent for five seconds is therefore a failed,
     * disposable provider generation: record it and replace the generation,
     * but keep the physical device lane connected and never replay the turn.
     */
    vi.useFakeTimers();
    const providerUnavailable = vi.fn();
    const { bridge, device, diagnostics, provider } = createBridge({
      onProviderUnavailable: providerUnavailable,
      turnDetection: "server-vad",
    });
    const controls = textMessages(provider.client);
    const deviceClosed = vi.fn();
    device.client.addEventListener("close", deviceClosed);

    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(controls).toEqual([]);
    expect(providerUnavailable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(controls).toEqual([]);
    expect(deviceClosed).not.toHaveBeenCalled();
    expect(providerUnavailable).toHaveBeenCalledOnce();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerAvailable: false,
      providerResponseCreateMessagesSent: 0,
      serverVadResponseTimeouts: 1,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "server-vad-response-timeout",
        severity: "error",
      }),
    );
  });

  test("does not manufacture a server-VAD response when Grok creates one normally", async () => {
    /*
     * Recovery must not turn a merely slow callback into two AI answers. A
     * provider response is authoritative even when it arrives just before the
     * watchdog boundary, so observing response.created permanently disarms
     * the one-shot timer for that utterance.
     */
    vi.useFakeTimers();
    const { bridge, provider } = createBridge({ turnDetection: "server-vad" });
    const controls = textMessages(provider.client);

    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await vi.advanceTimersByTimeAsync(4_999);
    provider.client.send(JSON.stringify({ type: "response.created" }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(controls).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      providerResponseCreateMessagesSent: 0,
    });
  });

  test("server VAD coalesces repeated speech starts behind one physical playback purge", async () => {
    /*
     * A marginal echo path can make Grok emit speech_started, speech_stopped,
     * then another speech_started before StackChan's audio owner has
     * acknowledged the first purge. The first purge already fences every
     * userspace downlink byte: issuing a second Cap'n Web request cannot make
     * the speaker cleaner, and the device deliberately rejects concurrent
     * hardware commands. That rejection used to close the otherwise healthy
     * PCM generation. This production ordering therefore has one public
     * requirement: both provider edges share the existing purge barrier, and
     * fresh audio remains blocked until its single acknowledgement arrives.
     */
    let acknowledgePlaybackReset: (() => void) | undefined;
    const interruptPlayback = vi.fn(
      () => new Promise<void>((resolve) => (acknowledgePlaybackReset = resolve)),
    );
    const { bridge, provider } = createBridge({
      onPlaybackInterruption: interruptPlayback,
      turnDetection: "server-vad",
    });

    /*
     * This scenario is specifically about coalescing while assistant audio is
     * live. Leave a partial provider frame in the bounded reservoir so the
     * first speech edge has a real stale sample to purge; an idle first turn
     * is covered separately and must not mutate physical playback at all.
     */
    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(new Uint8Array(300).fill(17));
    await vi.waitFor(() => expect(bridge.metrics().downlinkPartialBytes).toBe(300));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));

    await vi.waitFor(() => expect(bridge.metrics().providerSpeechStarts).toBe(2));
    expect(interruptPlayback).toHaveBeenCalledOnce();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      playbackInterruptionFailures: 0,
      playbackInterruptionPending: true,
      playbackInterruptionsCoalesced: 1,
      playbackInterruptionsCompleted: 0,
      playbackInterruptionsRequested: 1,
      providerSpeechStarts: 2,
      providerSpeechStops: 1,
    });

    acknowledgePlaybackReset?.();
    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        closed: false,
        playbackInterruptionFailures: 0,
        playbackInterruptionPending: false,
        playbackInterruptionsCoalesced: 1,
        playbackInterruptionsCompleted: 1,
        playbackInterruptionsRequested: 1,
      }),
    );
  });

  test("retires a provider whose server-VAD utterance never ends without closing the device lane", async () => {
    /*
     * The literal HAVPE failure was one speech_started edge followed by 95
     * seconds of transcript revisions and no speech_stopped. Leaving that
     * provider attached streams room audio indefinitely, never replies, and
     * cannot recover when the room becomes conversational again. Bound only
     * that disposable provider generation after one minute; keep `/pcm` warm,
     * retain an exact counter/diagnostic, and let the owner attach a fresh
     * provider that can recognize the next real utterance.
     */
    vi.useFakeTimers();
    const providerUnavailable = vi.fn();
    const { bridge, device, diagnostics, provider } = createBridge({
      onProviderUnavailable: providerUnavailable,
      turnDetection: "server-vad",
    });
    const deviceClosed = vi.fn();
    device.client.addEventListener("close", deviceClosed);

    provider.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.metrics()).toMatchObject({
      providerSpeechActiveSinceAtMs: expect.any(Number),
      providerSpeechStarts: 1,
      providerSpeechTimeouts: 0,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerAvailable: true,
      providerSpeechTimeouts: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(deviceClosed).not.toHaveBeenCalled();
    expect(providerUnavailable).toHaveBeenCalledOnce();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      conversationActive: true,
      providerAvailable: false,
      providerDisconnects: 1,
      providerRetirements: 1,
      providerSpeechActiveSinceAtMs: null,
      providerSpeechMaximumDurationMs: 60_000,
      providerSpeechTimeouts: 1,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "server-vad-speech-timeout",
        severity: "warn",
      }),
    );

    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);
    expect(bridge.attachProvider(replacement.server)).toBe(true);
    replacement.client.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.metrics()).toMatchObject({
      providerAvailable: true,
      providerConnections: 2,
      providerSpeechStarts: 2,
    });
  });

  test("server VAD rejects a firmware manual end marker as a policy mismatch", async () => {
    /*
     * The continuous capture gate suppresses zero-length uplink markers. If
     * one nevertheless crosses the authenticated full-duplex generation, the
     * two sides disagree about who owns turn detection. Treating it as an
     * ordinary empty turn would hide a firmware regression and leave future
     * speech boundaries ambiguous, so the generation must fail visibly.
     */
    const { bridge, device, diagnostics } = createBridge({
      turnDetection: "server-vad",
    });
    device.client.send(new Uint8Array(0));

    await vi.waitFor(() => expect(bridge.metrics().closed).toBe(true));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unexpected-uplink-end-marker",
        severity: "error",
      }),
    );
  });

  test("manual PTT release waits for the ordered PCM end marker before committing", async () => {
    /*
     * Button release and microphone bytes use independent WebSockets. A
     * control release can therefore arrive before the final PCM frame even
     * when both paths are healthy. Committing on that edge clips speech and
     * lets the late tail leak into the next turn. The device's empty binary
     * marker is ordered behind all accepted PCM on the media socket, so the
     * bridge must wait for it before asking Grok to commit.
     */
    const { bridge, device, provider } = createBridge({ turnDetection: "manual" });
    const controls = textMessages(provider.client);

    expect(bridge.inputStarted()).toBe(true);
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(19));
    await vi.waitFor(() => expect(bridge.metrics().uplinkFrames).toBe(1));
    expect(bridge.inputStopped()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toEqual([]);

    device.client.send(new Uint8Array(0));

    await vi.waitFor(() => expect(controls).toEqual(['{"type":"input_audio_buffer.commit"}']));

    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        '{"type":"input_audio_buffer.commit"}',
        '{"type":"response.create"}',
      ]),
    );
    expect(bridge.metrics()).toMatchObject({
      awaitingUplinkEndMarker: false,
      providerCommitMessagesSent: 1,
      providerControlMessagesSent: 2,
      providerResponseCreateMessagesSent: 1,
      providerSendFailures: 0,
      uplinkControlStarts: 1,
      uplinkControlStops: 1,
      uplinkEndMarkers: 1,
      uplinkTurns: 1,
    });
  });

  test("does not drop the first PCM frame when the next PTT control edge arrives later", async () => {
    /*
     * This is the production two-turn failure from 2026-08-01 reduced to its
     * actual ordering. The PCM and Cap'n Web sockets are independent: after
     * turn one's ordered marker, turn two's first 20 ms media frame may reach
     * the worker before the `pushToTalk.started` callback. FIFO proves that the
     * frame cannot belong to turn one, so treating it as a late tail loses live
     * speech and makes transport conservation fail despite a healthy network.
     *
     * The late control edge must also be idempotent. Resetting the count when
     * it catches up would make a one-frame press look empty and ask neither the
     * provider nor diagnostics to account for the speech already forwarded.
     */
    const { bridge, device, provider } = createBridge({ turnDetection: "manual" });
    const controls = textMessages(provider.client);
    const uplink = binaryMessages(provider.client);
    const first = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(31);
    const second = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(47);

    expect(bridge.inputStarted()).toBe(true);
    device.client.send(first);
    device.client.send(new Uint8Array(0));
    await vi.waitFor(() => expect(controls).toEqual(['{"type":"input_audio_buffer.commit"}']));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await vi.waitFor(() => expect(controls).toContain('{"type":"response.create"}'));
    provider.client.send(JSON.stringify({ type: "response.done" }));

    /*
     * This is the harder legal ordering, not merely the initially observed
     * START2 race: END1 and FRAME2 can both beat STOP1 on the media socket.
     * Monotonic control/marker accounting must attribute the delayed STOP1 to
     * marker one rather than arming a timeout against live turn two.
     */
    device.client.send(second);
    await vi.waitFor(() => expect(uplink).toEqual([first, second]));
    expect(bridge.inputStopped()).toBe(true);
    expect(bridge.inputStarted()).toBe(true);
    expect(bridge.inputStopped()).toBe(true);
    device.client.send(new Uint8Array(0));

    await vi.waitFor(() =>
      expect(
        controls.filter((message) => message === '{"type":"input_audio_buffer.commit"}'),
      ).toHaveLength(2),
    );
    expect(bridge.metrics()).toMatchObject({
      uplinkDroppedBytes: 0,
      uplinkControlStarts: 2,
      uplinkControlStops: 2,
      uplinkEndMarkers: 2,
      uplinkFrames: 2,
      uplinkTurns: 2,
    });
  });

  test("a provider control-send failure preserves the device lane for a fresh upstream", async () => {
    /*
     * A WebSocket can still report OPEN when its next synchronous send throws.
     * On a physical turn that boundary is the commit immediately after the
     * ordered microphone marker. Letting the exception escape the MessageEvent
     * or Cap'n Web callback can abort the Durable Object invocation and make
     * the device observe an unexplained 1006, destroying both independently
     * recoverable lanes. The provider generation is stale at that point, but
     * the device socket is not: classify the failed send, request one upstream
     * replacement, and leave the device connected with no hidden retry queue.
     */
    const providerUnavailable = vi.fn();
    const { bridge, device, diagnostics, provider } = createBridge({
      onProviderUnavailable: providerUnavailable,
      turnDetection: "manual",
    });
    const deviceClose = vi.fn();
    device.client.addEventListener("close", deviceClose);

    expect(bridge.inputStarted()).toBe(true);
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(37));
    await vi.waitFor(() => expect(bridge.metrics().uplinkFrames).toBe(1));
    vi.spyOn(provider.server, "send").mockImplementationOnce(() => {
      throw new Error("provider transport rejected commit");
    });
    device.client.send(new Uint8Array(0));

    await vi.waitFor(() => expect(providerUnavailable).toHaveBeenCalledOnce());
    expect(bridge.inputStopped()).toBe(true);

    expect(deviceClose).not.toHaveBeenCalled();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerAvailable: false,
      providerDisconnects: 1,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "provider-send-failed",
        severity: "error",
      }),
    );
  });

  test("does not ask Grok to commit an empty manual PTT turn", async () => {
    /*
     * Remote test controls can produce a real press/release pair inside one
     * audio-owner interval, so the firmware deliberately preserves it as an
     * ordered marker-only turn. Grok must not receive an empty-buffer commit:
     * providers are allowed to reject that command, and doing so would turn a
     * harmless no-speech gesture into a disconnected morning conversation.
     */
    const { bridge, device, diagnostics, provider } = createBridge({
      turnDetection: "manual",
    });
    const controls = textMessages(provider.client);

    expect(bridge.inputStarted()).toBe(true);
    expect(bridge.inputStopped()).toBe(true);
    device.client.send(new Uint8Array(0));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      awaitingUplinkEndMarker: false,
      emptyUplinkTurns: 1,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "empty-uplink-turn",
        severity: "info",
      }),
    );
  });

  test("the ordered PCM lane can complete a turn without either Cap'n Web edge", async () => {
    /*
     * Button events are useful provenance, but requiring either of them for
     * media correctness recreates cross-WebSocket ordering assumptions. A
     * non-empty frame opens a turn and the zero-length marker closes it; this
     * test is the smallest statement of that production contract.
     */
    const { bridge, device, provider } = createBridge({ turnDetection: "manual" });
    const controls = textMessages(provider.client);
    const uplink = binaryMessages(provider.client);
    const frame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(9);

    device.client.send(frame);
    device.client.send(new Uint8Array(0));
    await vi.waitFor(() => expect(controls).toEqual(['{"type":"input_audio_buffer.commit"}']));
    expect(uplink).toEqual([frame]);
    expect(bridge.metrics()).toMatchObject({
      emptyUplinkTurns: 0,
      uplinkControlStarts: 0,
      uplinkControlStops: 0,
      uplinkEndMarkers: 1,
      uplinkFrames: 1,
      uplinkTurns: 1,
    });
  });

  test("a missing end marker terminates the ambiguous turn after a bounded wait", async () => {
    /*
     * Silently waiting would leave Grok's manual input buffer and a Durable
     * Object timer alive forever; committing anyway would guess that missing
     * microphone bytes do not exist. The only honest recovery is a classified,
     * bounded generation failure whose counter survives in the closed report.
     */
    vi.useFakeTimers();
    const { bridge, device, diagnostics } = createBridge({ turnDetection: "manual" });

    expect(bridge.inputStarted()).toBe(true);
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(23));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.inputStopped()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(bridge.metrics()).toMatchObject({
      awaitingUplinkEndMarker: true,
      closed: false,
      uplinkEndMarkerTimeouts: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.metrics()).toMatchObject({
      awaitingUplinkEndMarker: false,
      closed: true,
      uplinkEndMarkerTimeouts: 1,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "uplink-end-marker-timeout",
        severity: "error",
      }),
    );
  });

  test("returns every device tool result before requesting one continuation response", async () => {
    /*
     * Grok may issue several function calls in one response. Continuing after
     * the first result lets it answer without the remaining physical changes;
     * waiting only for RPC completion but not response.done can also overlap
     * the continuation with current speech. This models two sprite requests
     * completing out of order and protects both fences.
     */
    const pending = new Map<string, (value: unknown) => void>();
    const calls: ProviderFunctionCall[] = [];
    const { bridge, provider } = createBridge({
      onProviderFunctionCall: (call) => {
        calls.push(call);
        return new Promise((resolve) => pending.set(call.callId, resolve));
      },
    });
    const controls = textMessages(provider.client);

    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(
      JSON.stringify({
        arguments: '{"spriteSet":"starbyte"}',
        call_id: "call_starbyte",
        name: "changeSpriteSet",
        type: "response.function_call_arguments.done",
      }),
    );
    provider.client.send(
      JSON.stringify({
        arguments: '{"spriteSet":"karakuri-brass"}',
        call_id: "call_karakuri",
        name: "changeSpriteSet",
        type: "response.function_call_arguments.done",
      }),
    );
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    pending.get("call_karakuri")?.({ ok: true, spriteSet: "karakuri-brass" });
    await vi.waitFor(() => expect(controls).toHaveLength(1));
    expect(controls[0]).toBe(
      JSON.stringify({
        item: {
          call_id: "call_karakuri",
          output: JSON.stringify({ ok: true, spriteSet: "karakuri-brass" }),
          type: "function_call_output",
        },
        type: "conversation.item.create",
      }),
    );

    pending.get("call_starbyte")?.({ ok: true, spriteSet: "starbyte" });
    await vi.waitFor(() => expect(controls).toHaveLength(3));
    expect(controls[1]).toBe(
      JSON.stringify({
        item: {
          call_id: "call_starbyte",
          output: JSON.stringify({ ok: true, spriteSet: "starbyte" }),
          type: "function_call_output",
        },
        type: "conversation.item.create",
      }),
    );
    expect(controls[2]).toBe('{"type":"response.create"}');
    expect(bridge.metrics()).toMatchObject({
      lastProviderEventType: "response.done",
      providerResponseActive: false,
      providerResponsesCompleted: 1,
    });

    provider.client.send(JSON.stringify({ type: "response.created" }));
    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        lastProviderEventType: "response.created",
        providerResponseActive: true,
        providerResponsesCompleted: 1,
      }),
    );
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        lastProviderEventType: "response.done",
        providerResponseActive: false,
        providerResponsesCompleted: 2,
      }),
    );
  });

  test("does not synthesize a duplicate continuation when the tool response already spoke", async () => {
    /*
     * A production Grok turn returned both changeSpriteSet and a complete spoken
     * sentence in one response. Unconditionally sending response.create after
     * the tool result made Grok speak that same sentence again: digital frame
     * accounting stayed perfect, but the physical microphone correctly heard
     * two copies. The tool output still belongs in conversation history; only
     * the redundant continuation request must be suppressed.
     */
    const { bridge, device, provider } = createBridge({
      onProviderFunctionCall: async () => ({ ok: true, spriteSet: "starbyte" }),
    });
    const controls = textMessages(provider.client);
    const downlink = binaryMessages(device.client);

    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(7));
    provider.client.send(
      JSON.stringify({
        arguments: '{"spriteSet":"starbyte"}',
        call_id: "call_starbyte",
        name: "changeSpriteSet",
        type: "response.function_call_arguments.done",
      }),
    );
    provider.client.send(JSON.stringify({ type: "response.done" }));

    await vi.waitFor(() => expect(downlink.at(-1)).toHaveLength(0));
    await vi.waitFor(() => expect(controls).toHaveLength(1));
    expect(controls[0]).toContain('"type":"function_call_output"');
    expect(controls).not.toContain('{"type":"response.create"}');
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerFunctionCallFailures: 0,
      providerFunctionCalls: 1,
      providerFunctionCallsPending: 0,
      providerResponsesCompleted: 1,
    });
  });

  test("does not return a late tool result to a replacement provider generation", async () => {
    /*
     * A device capability RPC can outlive an upstream WebSocket. Its eventual
     * result belongs only to the provider generation that requested it; feeding
     * it to a replacement would splice old conversation state into a fresh
     * Grok session even though all PCM generation fences were otherwise sound.
     */
    let finishTool: ((value: unknown) => void) | undefined;
    const { bridge, provider } = createBridge({
      onProviderFunctionCall: () =>
        new Promise((resolve) => {
          finishTool = resolve;
        }),
    });
    const oldControls = textMessages(provider.client);
    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(
      JSON.stringify({
        arguments: '{"spriteSet":"starbyte"}',
        call_id: "old_call",
        name: "changeSpriteSet",
        type: "response.function_call_arguments.done",
      }),
    );
    await vi.waitFor(() => expect(finishTool).toBeTypeOf("function"));

    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);
    const replacementControls = textMessages(replacement.client);
    expect(bridge.attachProvider(replacement.server)).toBe(true);
    finishTool?.({ ok: true, spriteSet: "starbyte" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(oldControls).toEqual([]);
    expect(replacementControls).toEqual([]);
  });

  test("a new PTT press supersedes a committed turn whose acknowledgement arrived late", async () => {
    /*
     * A physical user can press again while the provider is still acknowledging
     * the prior release. That second press is an interruption, so a late
     * acknowledgement must not resurrect the stale turn and speak over the
     * newly captured microphone audio.
     */
    const { bridge, device, provider } = createBridge({ turnDetection: "manual" });
    const controls = textMessages(provider.client);

    bridge.inputStarted();
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(27));
    device.client.send(new Uint8Array(0));
    await vi.waitFor(() => expect(bridge.metrics()).toMatchObject({ uplinkEndMarkers: 1 }));
    expect(bridge.inputStopped()).toBe(true);
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(41));
    await vi.waitFor(() => expect(bridge.metrics().uplinkTurns).toBe(2));
    expect(bridge.inputStarted()).toBe(true);
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));

    await vi.waitFor(() => expect(controls).toEqual(['{"type":"input_audio_buffer.commit"}']));
    expect(bridge.metrics()).toMatchObject({ interrupted: true });
  });

  test("does not cancel a nonexistent response on the first PTT press", async () => {
    /*
     * Grok Voice 2.0 treats response.cancel as an operation on a concrete
     * response, not as an idempotent "be quiet" command. Sending it before the
     * first response caused the provider to close an otherwise healthy PCM
     * generation; firmware then hit its bounded reconnect path and the next
     * event callback could not mount. The first press must therefore only
     * enter interrupted/capture state. A later press while provider audio is
     * active remains the actual interruption case covered above.
     */
    const { bridge, device, provider } = createBridge({ turnDetection: "manual" });
    const controls = textMessages(provider.client);

    expect(bridge.inputStarted()).toBe(true);
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(13));
    await vi.waitFor(() => expect(bridge.metrics().uplinkFrames).toBe(1));

    expect(controls).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      interrupted: true,
      uplinkTurns: 1,
    });
  });

  test("accepts a provider packet larger than the device lead into the bounded reservoir", async () => {
    vi.useFakeTimers();
    const { bridge, device, diagnostics, provider } = createBridge();
    const downlink = binaryMessages(device.client);
    provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES * 13));
    await vi.advanceTimersByTimeAsync(0);

    expect(downlink).toHaveLength(0);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkFrames: 0,
      downlinkPartialBytes: 0,
      downlinkQueuedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 13,
      downlinkQueueHighWaterBytes: ITERATE_KIT_PCM_FRAME_BYTES * 13,
    });

    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(20);
    expect(downlink.filter((frame) => frame.byteLength > 0)).toHaveLength(13);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "downlink-overflow" }));
  });

  test("plays a thirty-second provider burst without replacing the device lane", async () => {
    /*
     * grok-voice-think-fast-2.0 generated roughly ten seconds of speech in
     * under two seconds during a physical long-story turn. The old eight-
     * second userspace reservoir therefore filled at exactly 254,714 of its
     * 256,000 bytes and closed the otherwise healthy Stick socket with code
     * 4000. That is source acceleration, not stale network audio: the device
     * must still receive the response at its realtime playout rate and retain
     * the same WebSocket generation throughout a normal long answer.
     *
     * Thirty seconds is an external worked example (1,500 20 ms frames), not
     * a value derived from the implementation's queue bound. The public
     * provider/device WebSocket seam also proves exact frame conservation and
     * the final response marker without reaching into the ring itself.
     */
    vi.useFakeTimers();
    const { bridge, device, diagnostics, provider } = createBridge();
    const downlink = binaryMessages(device.client);
    const response = new Uint8Array(1_500 * ITERATE_KIT_PCM_FRAME_BYTES).fill(61);

    provider.client.send(response);
    provider.client.send(
      JSON.stringify({ response: { status: "completed" }, type: "response.done" }),
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkDroppedBytes: 0,
      downlinkFrames: 1_500,
      downlinkQueuedBytes: 0,
      providerResponsesCompleted: 1,
    });
    expect(downlink).toHaveLength(1_501);
    expect(downlink.slice(0, -1).every((frame) => frame.byteLength === 640)).toBe(true);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "downlink-overflow" }));
  });

  test("retains the measured seventy-two-second Grok story while pacing the Stick in realtime", async () => {
    /*
     * A production grok-voice-think-fast-2.0 response produced 1,150,093 PCM
     * samples (71.88 seconds) faster than the Stick could play them. The old
     * sixty-second reservoir retired the healthy provider generation at 1.87
     * MB, discarded its queued tail, and made the user hear a story cut off
     * after roughly eleven seconds. This is legitimate provider acceleration,
     * not permission to move the burst into the device or TCP buffers.
     *
     * Preserve that literal incident duration as the regression boundary:
     * userspace may hold the finite future of the current response, while the
     * device must still see exact 20 ms frames and one final response marker.
     */
    vi.useFakeTimers();
    const { bridge, device, diagnostics, provider } = createBridge();
    const downlink = binaryMessages(device.client);
    const measuredStoryFrames = 3_600;

    provider.client.send(
      new Uint8Array(measuredStoryFrames * ITERATE_KIT_PCM_FRAME_BYTES).fill(73),
    );
    provider.client.send(
      JSON.stringify({ response: { status: "completed" }, type: "response.done" }),
    );
    await vi.advanceTimersByTimeAsync(measuredStoryFrames * 20);

    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkDroppedBytes: 0,
      downlinkFrames: measuredStoryFrames,
      downlinkQueuedBytes: 0,
      providerResponsesCompleted: 1,
    });
    expect(downlink).toHaveLength(measuredStoryFrames + 1);
    expect(downlink.slice(0, -1).every((frame) => frame.byteLength === 640)).toBe(true);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "downlink-overflow" }));
  });

  test("retains the measured 300-to-400 Grok count while hardware plays it in realtime", async () => {
    /*
     * A direct grok-voice-think-fast-2.0 measurement on 2026-08-04 produced
     * 4,920,064 PCM bytes: 153.752 seconds generated in 20.85 seconds. The old
     * 90-second reservoir therefore made the mandatory count/interruption
     * acceptance scenario impossible even with a perfect device and network.
     * Round the final partial provider chunk up to one 640-byte device frame;
     * the public sockets must conserve all 7,688 frames and the response marker
     * without moving that accelerated future audio into embedded RAM.
     */
    vi.useFakeTimers();
    const { bridge, device, diagnostics, provider } = createBridge();
    const downlink = binaryMessages(device.client);
    const measuredCountFrames = 7_688;

    provider.client.send(
      new Uint8Array(measuredCountFrames * ITERATE_KIT_PCM_FRAME_BYTES).fill(79),
    );
    provider.client.send(
      JSON.stringify({ response: { status: "completed" }, type: "response.done" }),
    );
    await vi.advanceTimersByTimeAsync(measuredCountFrames * 20);

    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkDroppedBytes: 0,
      downlinkFrames: measuredCountFrames,
      downlinkResponseReservoirCapacityBytes: 5_760_000,
      downlinkQueuedBytes: 0,
      maximumProviderResponseDurationMs: 180_000,
      providerResponsesCompleted: 1,
    });
    expect(downlink).toHaveLength(measuredCountFrames + 1);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "downlink-overflow" }));
  });

  test("feeds a long response from hardware release credit without cross-clock drift", async () => {
    /*
     * The physical HAVPE count-to-100 incident disproved the old test model:
     * userspace admitted all frames on a perfect 20 ms fake clock, while the
     * finite 32-slot hardware ring eventually reached high-water 32 and its
     * transport retired the call around audible number 37. A WebSocket send
     * only proves local runtime acceptance; it says nothing about the ESP's
     * independent I2S clock or current receive-ring depth.
     *
     * Model a deliberately large 5% clock disagreement for 72 seconds. The
     * device emits cumulative credit only when its independent hardware clock
     * releases an ordered lane item. This makes clock drift an ordinary supply
     * rate rather than a second timer for userspace to estimate or correct.
     * Every frame must survive without overflowing a 32-item peer,
     * accumulating delay, or replacing the call.
     */
    vi.useFakeTimers();
    const { bridge, device, diagnostics, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    const deviceCapacityFrames = 32;
    const responseFrames = 3_600;
    let deviceDepthFrames = 0;
    let deviceHighWaterFrames = 0;
    let deviceOverflowFrames = 0;
    let devicePlayedFrames = 0;
    let deviceReceivedFrames = 0;
    let deviceReleasedItems = 0;
    const deviceItems: boolean[] = [];

    device.client.addEventListener("message", (event) => {
      const bytes =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
            : null;
      if (bytes === null) return;
      if (deviceItems.length >= deviceCapacityFrames) {
        deviceOverflowFrames += 1;
        return;
      }
      const isPcm = bytes.byteLength > 0;
      deviceItems.push(isPcm);
      if (isPcm) {
        deviceReceivedFrames += 1;
        deviceDepthFrames += 1;
      }
      deviceHighWaterFrames = Math.max(deviceHighWaterFrames, deviceDepthFrames);
    });

    const playbackClock = setInterval(() => {
      const isPcm = deviceItems.shift();
      if (isPcm === undefined) return;
      if (isPcm) {
        deviceDepthFrames -= 1;
        devicePlayedFrames += 1;
      }
      deviceReleasedItems += 1;
      device.client.send(downlinkReceipt(deviceReleasedItems));
    }, 21);
    const depthFeedback = setInterval(() => {
      bridge.observeDeviceDownlinkDepth(deviceDepthFrames);
    }, 1_000);

    provider.client.send(new Uint8Array(responseFrames * ITERATE_KIT_PCM_FRAME_BYTES).fill(83));
    provider.client.send(
      JSON.stringify({ response: { status: "completed" }, type: "response.done" }),
    );
    await vi.advanceTimersByTimeAsync(77_000);
    clearInterval(playbackClock);
    clearInterval(depthFeedback);

    expect(deviceOverflowFrames).toBe(0);
    expect(deviceReceivedFrames).toBe(responseFrames);
    expect(devicePlayedFrames).toBe(responseFrames);
    expect(deviceDepthFrames).toBe(0);
    expect(deviceHighWaterFrames).toBeLessThan(deviceCapacityFrames);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      deviceDownlinkDepthCorrections: 0,
      deviceDownlinkDepthMaximumFrames: expect.any(Number),
      deviceDownlinkDepthObservations: 77,
      downlinkDroppedBytes: 0,
      downlinkFrames: responseFrames,
    });
    expect(bridge.metrics().downlinkMaximumInFlightItems).toBeLessThanOrEqual(16);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ severity: "error" }));
  });

  test("retires only an oversized provider response and keeps the device lane reusable", async () => {
    /*
     * The response reservoir is deliberately finite: an unbounded story must
     * not turn into an unbounded Durable Object. Exhausting that response-local
     * budget also must not masquerade as an ESP/network crash. The already-
     * admitted device lead ends with an ordinary PCM response marker, the
     * disposable provider generation is retired, and a replacement provider
     * can serve the next turn on the exact same device WebSocket.
     *
     * This public-socket example exceeds the documented 180-second budget by
     * one frame after the sixteen-frame device lead has been admitted. It proves
     * both bounded loss accounting and recovery without inspecting queue
     * offsets or any private scheduler state.
     */
    vi.useFakeTimers();
    const providerUnavailable = vi.fn();
    const { bridge, device, diagnostics, provider } = createBridge({
      onProviderUnavailable: providerUnavailable,
    });
    const downlink = binaryMessages(device.client);
    const deviceClosed = vi.fn();
    device.client.addEventListener("close", deviceClosed);

    provider.client.send(new Uint8Array(9_000 * ITERATE_KIT_PCM_FRAME_BYTES).fill(17));
    provider.client.send(new Uint8Array(17 * ITERATE_KIT_PCM_FRAME_BYTES).fill(23));
    await vi.advanceTimersByTimeAsync(0);

    expect(deviceClosed).not.toHaveBeenCalled();
    expect(providerUnavailable).toHaveBeenCalledOnce();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkDroppedBytes: 9_001 * ITERATE_KIT_PCM_FRAME_BYTES,
      downlinkFrames: 16,
      downlinkQueuedBytes: 0,
      lastSocketClose: {
        code: 4000,
        source: "provider",
      },
      providerAvailable: false,
    });
    expect(downlink).toHaveLength(17);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "downlink-overflow", severity: "error" }),
    );

    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);
    expect(bridge.attachProvider(replacement.server)).toBe(true);
    replacement.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(29));
    replacement.client.send(
      JSON.stringify({ response: { status: "completed" }, type: "response.done" }),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(deviceClosed).not.toHaveBeenCalled();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkFrames: 17,
      providerAvailable: true,
      providerResponsesCompleted: 1,
    });
    expect(downlink.at(-2)?.[0]).toBe(29);
    expect(downlink.at(-1)).toHaveLength(0);
  });

  test("finishes an overflowed provider boundary before admitting replacement audio", async () => {
    /*
     * The overflow path retires only Grok and owes the device one zero-length
     * response marker. If all sixteen hardware credits are occupied, that
     * marker cannot cross until the DAC releases a slot. A replacement Grok
     * generation can attach in the meantime. Its first short packet must not
     * inherit the retired generation's `response.done` flag: doing so bypasses
     * the 32-frame source watermark, splices new speech before the old EOS,
     * and can make firmware treat an in-progress answer as already complete.
     *
     * This test observes only public WebSocket items and hardware receipts.
     * It deliberately releases one physical slot after replacement PCM is
     * waiting; the one newly visible item must be the old zero-length boundary,
     * never the replacement's under-watermark audio.
     */
    vi.useFakeTimers();
    const providerUnavailable = vi.fn();
    const { bridge, device, provider } = createBridge({
      automaticDownlinkReceipts: false,
      onProviderUnavailable: providerUnavailable,
    });
    const downlink = binaryMessages(device.client);

    provider.client.send(new Uint8Array(9_000 * ITERATE_KIT_PCM_FRAME_BYTES).fill(17));
    provider.client.send(new Uint8Array(17 * ITERATE_KIT_PCM_FRAME_BYTES).fill(23));
    await vi.advanceTimersByTimeAsync(0);
    expect(providerUnavailable).toHaveBeenCalledOnce();
    expect(downlink).toHaveLength(16);

    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);
    expect(bridge.attachProvider(replacement.server)).toBe(true);
    replacement.client.send(JSON.stringify({ type: "response.created" }));
    replacement.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(29));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink).toHaveLength(16);

    device.client.send(downlinkReceipt(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink).toHaveLength(17);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkQueuedBytes: ITERATE_KIT_PCM_FRAME_BYTES,
      downlinkRetiredBoundaryPending: false,
      providerAvailable: true,
    });
  });

  test("keeps a real provider burst in userspace behind a finite hardware-credit window", async () => {
    /*
     * A physical grok-voice-think-fast-2.0 turn produced a 203.28 ms gap
     * between provider packets. Forwarding a whole packet immediately does
     * not make that response realtime; it merely moves the variable provider
     * burst into TCP and the Stick's much smaller receive path. Conversely,
     * using the Stick's device lead as the source watermark cannot cover the
     * observed provider gap. A later production run then measured a 170 ms
     * post-send delivery gap while userspace itself reported zero timer
     * lateness. The old 160 ms lead was therefore one frame too short and
     * firmware visibly substituted silence. More importantly, the Stick's
     * sixteen-descriptor DMA cycle cannot start—and therefore cannot emit its
     * first hardware-release receipt—until sixteen ordered items arrive. A
     * twelve-item userspace window made both sides wait correctly forever.
     *
     * The public WebSocket seam is the contract under test: userspace waits
     * for 32 generated frames, primes exactly sixteen device frames, and then
     * admits only the number of slots the hardware consumer releases. A timer
     * cannot manufacture credit even when the observed provider gap elapses.
     */
    vi.useFakeTimers();
    const { device, diagnostics, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    const downlink = binaryMessages(device.client);
    const source = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES * 32);
    for (let frame = 0; frame < 32; frame += 1) {
      source.fill(
        frame + 1,
        frame * ITERATE_KIT_PCM_FRAME_BYTES,
        (frame + 1) * ITERATE_KIT_PCM_FRAME_BYTES,
      );
    }

    provider.client.send(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );

    await vi.advanceTimersByTimeAsync(203);
    expect(downlink).toHaveLength(16);
    device.client.send(downlinkReceipt(10));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    );
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ severity: "error" }));

    device.client.send(downlinkReceipt(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 27 }, (_, index) => index + 1),
    );
  });

  test.each([8, 12, 32])(
    "makes a %i-frame source-readiness candidate observable at the public socket seam",
    async (sourceStartupFrames) => {
      /*
       * The adversarial review requested a bounded 8/12/32 A/B instead of
       * treating the historical 32-frame source watermark as folklore. The
       * provider socket and device socket are the two production boundaries:
       * no PCM may escape before the selected amount exists, and reaching the
       * threshold may prime only the finite hardware-credit window. This test
       * deliberately does not declare the smaller candidates healthy—the
       * Stick needs sixteen descriptors before it can release credit, while
       * the retained provider trace contains a 203.28 ms packet gap. It makes
       * each policy executable so those independent physical facts, rather
       * than an untestable constant, decide promotion.
       */
      const { device, provider } = createBridge({
        automaticDownlinkReceipts: false,
        downlinkSourceStartupFrames: sourceStartupFrames,
      });
      const downlink = binaryMessages(device.client);

      for (let frame = 1; frame < sourceStartupFrames; frame += 1) {
        provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(frame));
      }
      await vi.waitFor(() => expect(downlink).toEqual([]));

      provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(sourceStartupFrames));
      await vi.waitFor(() =>
        expect(downlink.map((frame) => frame[0])).toEqual(
          Array.from({ length: Math.min(sourceStartupFrames, 16) }, (_, index) => index + 1),
        ),
      );
    },
  );

  test("monotonic time cannot admit or expire media without a hardware release", async () => {
    /*
     * The 68-second physical Grok story retained a full userspace source
     * reservoir and a healthy device socket, yet callback gaps could consume
     * the finite lead and force firmware to replace speech with silence. The
     * clean ownership rule is stronger than bounded catch-up: userspace time
     * has no authority over the DAC. Even an arbitrary clock jump changes
     * nothing until firmware reports that the hardware freed a slot.
     */
    vi.useFakeTimers();
    const { bridge, device, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    const downlink = binaryMessages(device.client);
    const source = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES * 32);
    for (let frame = 0; frame < 32; frame += 1) {
      source.fill(
        frame + 1,
        frame * ITERATE_KIT_PCM_FRAME_BYTES,
        (frame + 1) * ITERATE_KIT_PCM_FRAME_BYTES,
      );
    }

    provider.client.send(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );

    const monotonicClock = vi.spyOn(performance, "now").mockReturnValue(50_000);
    await vi.advanceTimersByTimeAsync(500);
    monotonicClock.mockRestore();

    expect(downlink).toHaveLength(16);
    device.client.send(downlinkReceipt(8));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkDroppedBytes: 0,
      downlinkPacingCatchUpFrames: 0,
      downlinkPacingCatchUpIncidents: 0,
      downlinkPacingMaximumLatenessMs: 0,
      downlinkPacingOverrunFrames: 0,
    });
  });

  test("never admits more than the finite device window without application receipts", async () => {
    /*
     * Cloudflare workerd has no server-side WebSocket bufferedAmount. The old
     * guard therefore read zero while a physical HAVPE run lost 83 frames
     * below send(). Hold every device receipt and advance well beyond the media
     * clock: exactly the declared sixteen-item lead may cross, all future audio
     * remains in the inspectable userspace reservoir, and a finite watchdog
     * replaces the ambiguous socket instead of accumulating delay forever.
     */
    vi.useFakeTimers();
    const { bridge, device, diagnostics, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    const downlink = binaryMessages(device.client);
    provider.client.send(new Uint8Array(32 * ITERATE_KIT_PCM_FRAME_BYTES).fill(19));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink).toHaveLength(16);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(downlink).toHaveLength(16);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkItemsAcknowledged: 0,
      downlinkItemsInFlight: 16,
      downlinkItemsSent: 16,
      downlinkMaximumInFlightItems: 16,
      downlinkQueuedBytes: 16 * ITERATE_KIT_PCM_FRAME_BYTES,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.metrics()).toMatchObject({
      closed: true,
      downlinkReceiptTimeouts: 1,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "downlink-device-receipt-timeout",
        severity: "error",
      }),
    );
  });

  test("cumulative receipts release exact credit and duplicates release none", async () => {
    /*
     * Receipts are cumulative so firmware may coalesce several receive bursts
     * into one eight-byte write. Grant five items, then repeat that same value:
     * pacing may consume exactly five new credits, while the duplicate is
     * idempotent and cannot enlarge the opaque device window.
     */
    vi.useFakeTimers();
    const { bridge, device, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    const downlink = binaryMessages(device.client);
    provider.client.send(new Uint8Array(32 * ITERATE_KIT_PCM_FRAME_BYTES).fill(31));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink).toHaveLength(16);

    device.client.send(downlinkReceipt(5));
    await vi.advanceTimersByTimeAsync(100);
    expect(downlink).toHaveLength(21);
    expect(bridge.metrics()).toMatchObject({
      downlinkItemsAcknowledged: 5,
      downlinkItemsInFlight: 16,
      downlinkItemsSent: 21,
    });

    device.client.send(downlinkReceipt(5));
    await vi.advanceTimersByTimeAsync(200);
    expect(downlink).toHaveLength(21);
    expect(bridge.metrics()).toMatchObject({
      downlinkDuplicateReceipts: 1,
      downlinkItemsInFlight: 16,
    });
  });

  test("hardware release credit preserves ordered audio after a delayed userspace wake", async () => {
    /*
     * The physical StackChan run that motivated this test measured a 380 ms
     * userspace callback delay while the codec's DMA clock kept consuming its
     * already-buffered lead. The old worker treated its own late JavaScript
     * clock as proof that audio had expired and discarded thirteen perfectly
     * ordered provider frames. That made the deterministic return audibly
     * choppy even though the device, not the isolate, owns the playout clock.
     *
     * Hold all hardware-consumption receipts while 500 ms passes, then release
     * the initial sixteen slots at once. Time alone must neither drop nor admit
     * media: the cumulative release fact grants exactly sixteen credits, and
     * the next sixteen oldest frames must cross in order immediately.
     */
    vi.useFakeTimers();
    const { bridge, device, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    const downlink = binaryMessages(device.client);
    const source = new Uint8Array(32 * ITERATE_KIT_PCM_FRAME_BYTES);
    for (let frame = 0; frame < 32; frame += 1) {
      source.fill(
        frame + 1,
        frame * ITERATE_KIT_PCM_FRAME_BYTES,
        (frame + 1) * ITERATE_KIT_PCM_FRAME_BYTES,
      );
    }

    provider.client.send(source);
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );

    await vi.advanceTimersByTimeAsync(500);
    device.client.send(downlinkReceipt(16));
    await vi.advanceTimersByTimeAsync(0);

    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    expect(bridge.metrics()).toMatchObject({
      downlinkDroppedBytes: 0,
      downlinkItemsAcknowledged: 16,
      downlinkItemsInFlight: 16,
      downlinkItemsSent: 32,
      downlinkQueuedBytes: 0,
      downlinkPacingOverrunFrames: 0,
    });
  });

  test("the ordered response marker waits for and consumes device credit", async () => {
    /*
     * EOS occupies one playback-lane slot even though it contains no PCM. A
     * sixteen-frame answer therefore fills the whole initial window; sending
     * its marker before a receipt would make the server and device disagree
     * about the exact ordered-item ledger during a radio stall.
     */
    vi.useFakeTimers();
    const { bridge, device, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    const downlink = binaryMessages(device.client);
    provider.client.send(new Uint8Array(16 * ITERATE_KIT_PCM_FRAME_BYTES).fill(41));
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink).toHaveLength(16);

    device.client.send(downlinkReceipt(16));
    await vi.advanceTimersByTimeAsync(0);
    expect(downlink).toHaveLength(17);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(bridge.metrics()).toMatchObject({
      downlinkItemsAcknowledged: 16,
      downlinkItemsInFlight: 1,
      downlinkItemsSent: 17,
    });

    device.client.send(downlinkReceipt(17));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.metrics()).toMatchObject({
      downlinkItemsAcknowledged: 17,
      downlinkItemsInFlight: 0,
    });
  });

  test.each([
    { firstReceipt: 17, secondReceipt: undefined, problem: "forward" },
    { firstReceipt: 5, secondReceipt: 4, problem: "regressing" },
  ])("rejects a $problem device receipt without granting credit", async (scenario) => {
    /*
     * WebSocket ordering makes a forward or regressing cumulative value an
     * impossible peer state. Treating either as advisory would let malformed
     * device bytes manufacture credit and recreate the unbounded queue this
     * protocol is intended to eliminate.
     */
    vi.useFakeTimers();
    const { bridge, device, diagnostics, provider } = createBridge({
      automaticDownlinkReceipts: false,
    });
    provider.client.send(new Uint8Array(32 * ITERATE_KIT_PCM_FRAME_BYTES).fill(51));
    await vi.advanceTimersByTimeAsync(0);
    device.client.send(downlinkReceipt(scenario.firstReceipt));
    await vi.advanceTimersByTimeAsync(0);
    if (scenario.secondReceipt !== undefined) {
      device.client.send(downlinkReceipt(scenario.secondReceipt));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(bridge.metrics().closed).toBe(true);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid-device-receipt",
        severity: "error",
      }),
    );
  });

  test("keeps the device lane alive when an idle provider closes and accepts a fresh provider", async () => {
    /*
     * A provider session is a replaceable upstream generation, while `/pcm`
     * is the device's durable realtime lane. Grok can retire an otherwise
     * healthy idle socket before a human presses the button. Coupling those
     * lifetimes made the Stick reconnect and race its independently mounted
     * PTT capability, so the next physical turn never reached a provider.
     */
    const providerUnavailable = vi.fn();
    const { bridge, device, provider } = createBridge({
      onProviderUnavailable: providerUnavailable,
    });
    const deviceClose = vi.fn();
    device.client.addEventListener("close", deviceClose);

    provider.client.close(1000, "idle provider retired");
    await vi.waitFor(() => expect(providerUnavailable).toHaveBeenCalledOnce());

    expect(deviceClose).not.toHaveBeenCalled();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerAvailable: false,
      providerDisconnects: 1,
      lastSocketClose: {
        code: 1000,
        reason: "idle provider retired",
        source: "provider",
      },
    });

    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);
    const replacementUplink = binaryMessages(replacement.client);
    expect(bridge.attachProvider(replacement.server)).toBe(true);

    const frame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(23);
    device.client.send(frame);
    await vi.waitFor(() => expect(replacementUplink).toEqual([frame]));
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerAvailable: true,
      providerConnections: 2,
      uplinkFrames: 1,
    });
  });

  test("accepts the realtime device lane before the voice provider is available", async () => {
    /*
     * A call used to hold the Stick's WebSocket upgrade behind xAI credential
     * minting and a second TLS/WebSocket handshake. Production measured that
     * serial dependency as 4.70 seconds from call intent to `/pcm` readiness.
     * The device lane is independently useful and already has explicit fresh
     * audio loss semantics, so it must be constructible before its disposable
     * upstream generation. This is the contract that lets the worker answer
     * the device upgrade immediately and finish provider setup concurrently.
     */
    const device = socketPair();
    sockets.push(device.client, device.server);
    const bridge = new PcmSessionBridge({
      device: device.server,
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
      sessionId: "prj_test",
      turnDetection: "manual",
    });

    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerAvailable: false,
      providerConnections: 0,
    });

    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(17));
    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        uplinkDroppedBytes: ITERATE_KIT_PCM_FRAME_BYTES,
        uplinkUnavailableFrames: 1,
      }),
    );

    const provider = socketPair();
    sockets.push(provider.client, provider.server);
    const freshUplink = binaryMessages(provider.client);
    bridge.setConversationActive(true);
    expect(bridge.attachProvider(provider.server)).toBe(true);
    const freshFrame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(29);
    device.client.send(freshFrame);
    await vi.waitFor(() => expect(freshUplink).toEqual([freshFrame]));
  });

  test("asks Grok for one exact greeting only after the configured session is ready", async () => {
    /*
     * A WebSocket OPEN is not a configured Grok session. Asking for speech
     * before session.updated races the native PCM format, voice, manual turn
     * detection, and tool configuration. Conversely, waiting for the user's
     * first PTT release makes a connected call sound dead. The provider's
     * acknowledgement is therefore the one safe, deterministic greeting edge.
     * A repeated acknowledgement or replacement generation must not greet
     * again inside the same physical call.
     */
    const device = socketPair();
    const provider = socketPair();
    sockets.push(device.client, device.server, provider.client, provider.server);
    const controls = textMessages(provider.client);
    const bridge = new PcmSessionBridge({
      device: device.server,
      initialGreeting: "How can I help you?",
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
      sessionId: "prj_test",
      turnDetection: "server-vad",
    });
    bridge.setConversationActive(true);
    expect(bridge.attachProvider(provider.server)).toBe(true);

    provider.client.send(JSON.stringify({ type: "session.created" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toEqual([]);

    provider.client.send(JSON.stringify({ type: "session.updated" }));
    await vi.waitFor(() => expect(controls).toHaveLength(1));
    expect(controls.map((control) => JSON.parse(control) as unknown)).toEqual([
      {
        item: {
          content: [
            {
              text: "How can I help you?",
              type: "output_text",
            },
          ],
          interruptible: true,
          role: "assistant",
          type: "force_message",
        },
        type: "conversation.item.create",
      },
    ]);
    expect(bridge.metrics()).toMatchObject({
      initialGreetingRequests: 1,
      providerSessionReadyAtMs: expect.any(Number),
    });

    provider.client.send(JSON.stringify({ type: "session.updated" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toHaveLength(1);
    expect(bridge.metrics().initialGreetingRequests).toBe(1);
  });

  test("keeps a manual call silent until one complete PTT turn", async () => {
    /*
     * Opening Button B's call establishes infrastructure; it is not a user
     * turn. The production Stick briefly configured `initialGreeting`, which
     * made Grok speak before Button A and also created an avoidable response
     * to interrupt. With no explicit greeting, even session.updated must be
     * silent. Only the ordered mic frame/end marker/commit acknowledgement may
     * request the first response.
     */
    const device = socketPair();
    const provider = socketPair();
    sockets.push(device.client, device.server, provider.client, provider.server);
    const controls = textMessages(provider.client);
    const bridge = new PcmSessionBridge({
      device: device.server,
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
      sessionId: "prj_test",
      turnDetection: "manual",
    });
    bridge.setConversationActive(true);
    expect(bridge.attachProvider(provider.server)).toBe(true);

    provider.client.send(JSON.stringify({ type: "session.updated" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toEqual([]);
    expect(bridge.metrics().initialGreetingRequests).toBe(0);

    expect(bridge.inputStarted()).toBe(true);
    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(23));
    expect(bridge.inputStopped()).toBe(true);
    device.client.send(new Uint8Array(0));
    await vi.waitFor(() => expect(controls).toEqual(['{"type":"input_audio_buffer.commit"}']));
    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        '{"type":"input_audio_buffer.commit"}',
        '{"type":"response.create"}',
      ]),
    );
    const downlink = binaryMessages(device.client);
    const answer = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(47);
    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(answer);
    provider.client.send(
      JSON.stringify({ response: { status: "completed" }, type: "response.done" }),
    );
    await vi.waitFor(() => expect(downlink).toEqual([answer, new Uint8Array(0)]));
  });

  test("rejects every unsolicited provider response in a manual PTT call", async () => {
    /*
     * Button B opens infrastructure; only Button A release creates a user
     * turn. A provider generation that speaks after session.updated without
     * our response.create would otherwise recreate the exact unwanted
     * "How can I help you?" heard on the physical Stick while every local
     * greeting counter honestly remained zero. Treat response authorization
     * as a manual-mode protocol invariant: cancel the unsolicited response,
     * retain its raw control events for diagnosis, and admit none of its PCM.
     */
    const device = socketPair();
    const provider = socketPair();
    sockets.push(device.client, device.server, provider.client, provider.server);
    const providerControls = textMessages(provider.client);
    const deviceMessages = binaryMessages(device.client);
    const diagnostics: PcmProxyDiagnostic[] = [];
    const bridge = new PcmSessionBridge({
      device: device.server,
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      sessionId: "prj_test",
      turnDetection: "manual",
    });
    bridge.setConversationActive(true);
    expect(bridge.attachProvider(provider.server)).toBe(true);

    provider.client.send(JSON.stringify({ type: "session.updated" }));
    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(71));
    provider.client.send(
      JSON.stringify({ type: "response.done", response: { status: "cancelled" } }),
    );

    await vi.waitFor(() => expect(providerControls).toContain('{"type":"response.cancel"}'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deviceMessages).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsolicited-provider-response", severity: "error" }),
      ]),
    );
    expect(bridge.metrics()).toMatchObject({
      downlinkFrames: 0,
      providerUnsolicitedPcmBytes: ITERATE_KIT_PCM_FRAME_BYTES,
      providerUnsolicitedResponses: 1,
      providerResponseCreateMessagesSent: 0,
    });
  });

  test("manual PTT mode cannot be configured to greet at connection time", () => {
    /*
     * Keeping the old optional greeting field valid in manual mode made a
     * future worker edit capable of silently undoing the product decision.
     * Reject that invalid composition at construction instead of depending on
     * every caller to remember that Button B is not an assistant turn.
     */
    const device = socketPair();
    sockets.push(device.client, device.server);
    expect(
      () =>
        new PcmSessionBridge({
          device: device.server,
          initialGreeting: "How can I help you?",
          maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
          sessionId: "prj_test",
          turnDetection: "manual",
        }),
    ).toThrow("Manual push-to-talk sessions cannot configure an initial greeting.");
  });

  test("keeps the device lane warm while call lifetime creates and retires providers", async () => {
    /*
     * The physical latency incident came from giving Button B ownership of
     * DNS/TLS/WebSocket setup on the Stick. The correct lifetime split is a
     * boot-warm device lane plus one disposable provider per explicit call.
     * Hang-up must retire Grok and discard its state without closing `/pcm`;
     * the next call can then attach immediately without any device handshake.
     */
    const device = socketPair();
    const firstProvider = socketPair();
    sockets.push(device.client, device.server, firstProvider.client, firstProvider.server);
    const deviceClosed = vi.fn();
    const providerClosed = vi.fn();
    device.client.addEventListener("close", deviceClosed);
    firstProvider.client.addEventListener("close", providerClosed);
    const bridge = new PcmSessionBridge({
      device: device.server,
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
      sessionId: "prj_test",
      turnDetection: "manual",
    });

    expect(bridge.metrics()).toMatchObject({
      conversationActive: false,
      conversationStarts: 0,
      providerAvailable: false,
    });
    expect(bridge.attachProvider(firstProvider.server)).toBe(false);
    await vi.waitFor(() => expect(providerClosed).toHaveBeenCalledOnce());

    const activeProvider = socketPair();
    sockets.push(activeProvider.client, activeProvider.server);
    const activeProviderClosed = vi.fn();
    activeProvider.client.addEventListener("close", activeProviderClosed);
    expect(bridge.setConversationActive(true)).toBe(true);
    expect(bridge.attachProvider(activeProvider.server)).toBe(true);
    expect(bridge.metrics()).toMatchObject({
      conversationActive: true,
      conversationStarts: 1,
      providerAvailable: true,
    });

    expect(bridge.setConversationActive(false)).toBe(true);
    await vi.waitFor(() => expect(activeProviderClosed).toHaveBeenCalledOnce());
    expect(deviceClosed).not.toHaveBeenCalled();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      conversationActive: false,
      conversationEnds: 1,
      providerAvailable: false,
    });
  });

  test("ignores late messages and close events from a superseded provider generation", async () => {
    /*
     * WebSocket events already queued by workerd can arrive after replacement.
     * They must not inject stale speech or detach the new provider; generation
     * fencing is what makes reconnect a real freshness boundary.
     */
    const providerUnavailable = vi.fn();
    const { bridge, device, provider } = createBridge({
      onProviderUnavailable: providerUnavailable,
    });
    const downlink = binaryMessages(device.client);
    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);

    expect(bridge.attachProvider(replacement.server)).toBe(true);
    provider.server.dispatchEvent(
      new MessageEvent("message", {
        data: new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(11),
      }),
    );
    provider.server.dispatchEvent(
      new CloseEvent("close", { code: 4004, reason: "late old close" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(downlink).toEqual([]);
    expect(providerUnavailable).not.toHaveBeenCalled();
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      providerAvailable: true,
      providerConnections: 2,
      providerDisconnects: 0,
    });
  });

  test("drops current microphone audio without buffering while the provider is unavailable", async () => {
    /*
     * Reconnect must never turn outage audio into delayed conversation. A mic
     * frame observed without a live upstream is accounted once and discarded;
     * attaching a new provider starts from live audio only.
     */
    const providerUnavailable = vi.fn();
    const { bridge, device, provider } = createBridge({
      onProviderUnavailable: providerUnavailable,
    });
    provider.client.close(1000, "rotate");
    await vi.waitFor(() => expect(providerUnavailable).toHaveBeenCalledOnce());

    device.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(17));
    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        closed: false,
        uplinkDroppedBytes: ITERATE_KIT_PCM_FRAME_BYTES,
        uplinkUnavailableFrames: 1,
      }),
    );

    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);
    const uplink = binaryMessages(replacement.client);
    bridge.attachProvider(replacement.server);
    const currentFrame = new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(29);
    device.client.send(currentFrame);
    await vi.waitFor(() => expect(uplink).toEqual([currentFrame]));
  });

  test("retains a bounded provider failure and the exact socket close boundary", async () => {
    /*
     * The device normally reconnects within seconds, which used to erase the
     * failed generation before an operator could poll it. Keep only selected,
     * bounded provider fields: enough to attribute a turn failure without
     * retaining transcripts, arbitrary payloads, or an unbounded event log.
     */
    const { bridge, provider } = createBridge();
    provider.client.send(
      JSON.stringify({
        error: {
          code: "turn_failed",
          message: "x".repeat(1_000),
        },
        type: "error",
      }),
    );
    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        lastProviderError: {
          code: "turn_failed",
          message: "x".repeat(256),
        },
        lastProviderEventType: "error",
        providerControlEvents: 1,
      }),
    );

    provider.client.close(4004, "provider turn failed");
    await vi.waitFor(() =>
      expect(bridge.metrics()).toMatchObject({
        closed: false,
        providerAvailable: false,
        providerDisconnects: 1,
        lastSocketClose: {
          code: 4004,
          reason: "provider turn failed",
          source: "provider",
        },
      }),
    );
  });
});
