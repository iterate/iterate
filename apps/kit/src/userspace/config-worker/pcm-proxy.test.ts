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
      provider: provider.server,
      sessionId: "prj_test",
    });
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
    const { bridge, device, provider } = createBridge({
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

  test("relays each microphone frame immediately and preserves rechunked provider audio", async () => {
    const { device, provider } = createBridge();
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

    expect(bridge.inputStarted()).toBe(true);
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

  test("manual PTT release waits for the provider commit acknowledgement before requesting speech", async () => {
    const { bridge, provider } = createBridge();
    const controls = textMessages(provider.client);

    bridge.inputStarted();
    expect(bridge.inputStopped()).toBe(true);

    await vi.waitFor(() => expect(controls).toEqual(['{"type":"input_audio_buffer.commit"}']));

    provider.client.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        '{"type":"input_audio_buffer.commit"}',
        '{"type":"response.create"}',
      ]),
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
    const { bridge, provider } = createBridge();
    const controls = textMessages(provider.client);

    bridge.inputStarted();
    expect(bridge.inputStopped()).toBe(true);
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
    const { bridge, provider } = createBridge();
    const controls = textMessages(provider.client);

    expect(bridge.inputStarted()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controls).toEqual([]);
    expect(bridge.metrics()).toMatchObject({
      closed: false,
      interrupted: true,
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
