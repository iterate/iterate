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
      onProviderEvent?: (event: ProviderNonPcmEvent) => void;
      onProviderFunctionCall?: (call: ProviderFunctionCall) => Promise<unknown>;
      onProviderUnavailable?: () => void;
    } = {},
  ) {
    const device = socketPair();
    const provider = socketPair();
    sockets.push(device.client, device.server, provider.client, provider.server);
    const diagnostics: PcmProxyDiagnostic[] = [];
    const bridge = new PcmSessionBridge({
      device: device.server,
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onProviderEvent: options.onProviderEvent,
      onProviderFunctionCall: options.onProviderFunctionCall,
      onProviderUnavailable: options.onProviderUnavailable,
      sessionId: "prj_test",
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
    /* A response is playable only after the ordered media turn has ended. */
    device.client.send(new Uint8Array(0));
    await vi.waitFor(() => expect(bridge.metrics().uplinkEndMarkers).toBe(1));

    provider.client.send(microphoneFrame.slice(0, 117));
    provider.client.send(microphoneFrame.slice(117));
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(downlink).toHaveLength(2));
    expect(downlink[0]).toEqual(microphoneFrame);
    expect(downlink[1]).toHaveLength(0);
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
    const { bridge, device, provider } = createBridge();
    const controls = textMessages(provider.client);
    const downlink = binaryMessages(device.client);
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
    expect(bridge.metrics()).toMatchObject({
      downlinkPartialBytes: 0,
      interrupted: true,
    });

    provider.client.send(new Uint8Array(340).fill(9));
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(downlink).toHaveLength(1));
    expect(downlink[0]).toHaveLength(0);
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
    const { bridge, device, provider } = createBridge();
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
    const { bridge, device, provider } = createBridge();
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
    const { bridge, device, diagnostics, provider } = createBridge();
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
    const { bridge, device, provider } = createBridge();
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
    const { bridge, device, diagnostics } = createBridge();

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
     * the continuation with current speech. This models two colour requests
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
        arguments: '{"colour":"red"}',
        call_id: "call_red",
        name: "changeColour",
        type: "response.function_call_arguments.done",
      }),
    );
    provider.client.send(
      JSON.stringify({
        arguments: '{"colour":"green"}',
        call_id: "call_green",
        name: "changeColour",
        type: "response.function_call_arguments.done",
      }),
    );
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    pending.get("call_green")?.({ colour: "green", ok: true });
    await vi.waitFor(() => expect(controls).toHaveLength(1));
    expect(controls[0]).toBe(
      JSON.stringify({
        item: {
          call_id: "call_green",
          output: JSON.stringify({ colour: "green", ok: true }),
          type: "function_call_output",
        },
        type: "conversation.item.create",
      }),
    );

    pending.get("call_red")?.({ colour: "red", ok: true });
    await vi.waitFor(() => expect(controls).toHaveLength(3));
    expect(controls[1]).toBe(
      JSON.stringify({
        item: {
          call_id: "call_red",
          output: JSON.stringify({ colour: "red", ok: true }),
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
     * A production Grok turn returned both changeColour and a complete spoken
     * sentence in one response. Unconditionally sending response.create after
     * the tool result made Grok speak that same sentence again: digital frame
     * accounting stayed perfect, but the physical microphone correctly heard
     * two copies. The tool output still belongs in conversation history; only
     * the redundant continuation request must be suppressed.
     */
    const { bridge, device, provider } = createBridge({
      onProviderFunctionCall: async () => ({ colour: "green", ok: true }),
    });
    const controls = textMessages(provider.client);
    const downlink = binaryMessages(device.client);

    provider.client.send(JSON.stringify({ type: "response.created" }));
    provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES).fill(7));
    provider.client.send(
      JSON.stringify({
        arguments: '{"colour":"green"}',
        call_id: "call_green",
        name: "changeColour",
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
        arguments: '{"colour":"red"}',
        call_id: "old_call",
        name: "changeColour",
        type: "response.function_call_arguments.done",
      }),
    );
    await vi.waitFor(() => expect(finishTool).toBeTypeOf("function"));

    const replacement = socketPair();
    sockets.push(replacement.client, replacement.server);
    const replacementControls = textMessages(replacement.client);
    expect(bridge.attachProvider(replacement.server)).toBe(true);
    finishTool?.({ colour: "red", ok: true });
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
    const { bridge, device, provider } = createBridge();
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
    const { bridge, device, provider } = createBridge();
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
    provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES * 9));
    await vi.advanceTimersByTimeAsync(0);

    expect(downlink).toHaveLength(0);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      downlinkFrames: 0,
      downlinkPartialBytes: 0,
      downlinkQueuedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 9,
      downlinkQueueHighWaterBytes: ITERATE_KIT_PCM_FRAME_BYTES * 9,
    });

    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(20);
    expect(downlink.filter((frame) => frame.byteLength > 0)).toHaveLength(9);
    expect(downlink.at(-1)).toHaveLength(0);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "downlink-overflow" }));
  });

  test("keeps a real provider burst in userspace while feeding only a finite device lead", async () => {
    /*
     * A physical grok-voice-think-fast-2.0 turn produced a 203.28 ms gap
     * between provider packets. Forwarding a whole packet immediately does
     * not make that response realtime; it merely moves the variable provider
     * burst into TCP and the Stick's much smaller receive path. Conversely,
     * using the Stick's eight-frame lead as the source watermark cannot cover
     * the observed gap.
     *
     * The public WebSocket seam is the contract under test: userspace waits
     * for 32 generated frames, primes exactly eight device frames, and then
     * admits one frame per 20 ms. This literal timing example comes from the
     * successful physical run and deliberately does not mirror a scheduler
     * implementation.
     */
    vi.useFakeTimers();
    const { device, diagnostics, provider } = createBridge();
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
    expect(downlink.map((frame) => frame[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    await vi.advanceTimersByTimeAsync(203);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ severity: "error" }));

    await vi.advanceTimersByTimeAsync(17);
    expect(downlink.map((frame) => frame[0])).toEqual(
      Array.from({ length: 19 }, (_, index) => index + 1),
    );
  });

  test("closes rather than hiding stale audio in the runtime socket backlog", async () => {
    const { bridge, device, diagnostics, provider } = createBridge();
    Object.defineProperty(device.server, "bufferedAmount", {
      configurable: true,
      value: ITERATE_KIT_PCM_FRAME_BYTES * 8,
    });
    provider.client.send(new Uint8Array(ITERATE_KIT_PCM_FRAME_BYTES));
    provider.client.send(JSON.stringify({ type: "response.done" }));

    await vi.waitFor(() =>
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "downlink-overflow",
          severity: "error",
        }),
      ),
    );
    expect(bridge.metrics()).toMatchObject({
      closed: true,
      downlinkDroppedBytes: ITERATE_KIT_PCM_FRAME_BYTES,
    });
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
    });
    bridge.setConversationActive(true);
    expect(bridge.attachProvider(provider.server)).toBe(true);

    provider.client.send(JSON.stringify({ type: "session.created" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toEqual([]);

    provider.client.send(JSON.stringify({ type: "session.updated" }));
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    expect(controls.map((control) => JSON.parse(control) as unknown)).toEqual([
      {
        item: {
          content: [
            {
              text: 'Begin the call by saying exactly: "How can I help you?" Do not add any other words.',
              type: "input_text",
            },
          ],
          role: "user",
          type: "message",
        },
        type: "conversation.item.create",
      },
      { type: "response.create" },
    ]);
    expect(bridge.metrics()).toMatchObject({
      initialGreetingRequests: 1,
      providerSessionReadyAtMs: expect.any(Number),
    });

    provider.client.send(JSON.stringify({ type: "session.updated" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toHaveLength(2);
    expect(bridge.metrics().initialGreetingRequests).toBe(1);
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
      initialGreeting: "How can I help you?",
      maximumSocketBufferedBytes: ITERATE_KIT_PCM_FRAME_BYTES * 8,
      sessionId: "prj_test",
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
