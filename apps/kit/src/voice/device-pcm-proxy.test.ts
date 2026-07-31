import { createHash } from "node:crypto";
import { WebSocketPair } from "captun";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DeterministicPcmToneProvider } from "./deterministic-pcm-tone-provider.ts";
import {
  DevicePcmProxy,
  ITERATE_KIT_PCM_SUBPROTOCOL,
  projectBearerSubprotocol,
  type DevicePcmSocketClose,
  type PcmFrameObservation,
  type ProviderVoiceEvent,
} from "./device-pcm-proxy.ts";

const projectId = "prj_pcm_proxy_test";
const projectToken = "itxk-pcm-proxy-test-token";
const frameBytes = 640;

interface SocketPairFixture {
  client: WebSocket;
  server: WebSocket;
}

type AcceptingWebSocket = WebSocket & { accept(): void };

class StrictCloseWebSocket extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  readonly bufferedAmount = 0;
  readonly closeCodes: number[] = [];
  readonly extensions = "";
  readonly protocol = "";
  readyState: number = WebSocket.OPEN;
  readonly url = "wss://provider.invalid";

  close(code = 1000) {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error(`invalid close code ${code}`);
    }
    this.closeCodes.push(code);
    this.readyState = WebSocket.CLOSED;
  }

  send() {}
}

class DeferredBlob extends Blob {
  readonly #bytes: ArrayBuffer;
  #resolve: ((bytes: ArrayBuffer) => void) | undefined;

  constructor(bytes: Uint8Array) {
    const copy = Uint8Array.from(bytes).buffer as ArrayBuffer;
    super([copy]);
    this.#bytes = copy.slice(0);
  }

  override arrayBuffer() {
    return new Promise<ArrayBuffer>((resolve) => {
      this.#resolve = resolve;
    });
  }

  release() {
    this.#resolve?.(this.#bytes);
  }
}

function socketPair(): SocketPairFixture {
  const pair = new WebSocketPair();
  pair[0].accept();
  pair[1].accept();
  return { client: pair[1], server: pair[0] };
}

function waitForMessage(socket: WebSocket) {
  return new Promise<MessageEvent>((resolve) => {
    socket.addEventListener("message", resolve, { once: true });
  });
}

function waitForMessages(socket: WebSocket, count: number) {
  return new Promise<MessageEvent[]>((resolve) => {
    const messages: MessageEvent[] = [];
    const receive = (event: MessageEvent) => {
      messages.push(event);
      if (messages.length === count) {
        socket.removeEventListener("message", receive);
        resolve(messages);
      }
    };
    socket.addEventListener("message", receive);
  });
}

function waitForClose(socket: WebSocket) {
  return new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

function pcmRequest(options?: { project?: string; token?: string; tokenInProtocol?: boolean }) {
  const token = options?.token ?? projectToken;
  const protocols = [ITERATE_KIT_PCM_SUBPROTOCOL];
  const headers = new Headers({
    upgrade: "websocket",
    "x-iterate-project-id": options?.project ?? projectId,
  });
  if (options?.tokenInProtocol) {
    protocols.push(projectBearerSubprotocol(token));
  } else {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("sec-websocket-protocol", protocols.join(", "));
  return new Request("https://local.invalid/pcm", { headers });
}

describe("device PCM proxy", () => {
  const proxies: DevicePcmProxy[] = [];
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const proxy of proxies.splice(0)) proxy[Symbol.dispose]();
    for (const socket of sockets.splice(0)) socket.close();
    vi.useRealTimers();
  });

  function createProxy(options?: {
    closes?: DevicePcmSocketClose[];
    deviceClockedInitialBurstFrames?: number;
    downlinkCompletions?: number[];
    downlinkDeliveryMode?: "device-clocked" | "host-paced";
    events?: ProviderVoiceEvent[];
    failures?: string[];
    inputMode?: "push-to-talk" | "server-vad";
    maximumDownlinkQueuedBytes?: number;
    minimumDownlinkStartupFrames?: number;
    pcmFrames?: PcmFrameObservation[];
    provider?: SocketPairFixture;
    readySessions?: string[];
  }) {
    const provider = options?.provider ?? socketPair();
    sockets.push(provider.client, provider.server);
    const proxy = new DevicePcmProxy({
      authenticate(candidateProjectId, candidateToken) {
        return candidateProjectId === projectId && candidateToken === projectToken;
      },
      connectProvider: async () => provider.server,
      deviceClockedInitialBurstFrames: options?.deviceClockedInitialBurstFrames,
      downlinkDeliveryMode: options?.downlinkDeliveryMode,
      frameBytes,
      maximumDownlinkQueuedBytes: options?.maximumDownlinkQueuedBytes,
      minimumDownlinkStartupFrames: options?.minimumDownlinkStartupFrames,
      resolveSession: (_request, authenticatedProjectId) => ({
        id: authenticatedProjectId,
        inputMode: options?.inputMode ?? "server-vad",
      }),
      onFailure: (reason) => options?.failures?.push(reason),
      onDownlinkResponseComplete: (observedAt) => options?.downlinkCompletions?.push(observedAt),
      onProviderEvent: (event) => options?.events?.push(event),
      onPcmFrame: (frame) =>
        options?.pcmFrames?.push({
          ...frame,
          bytes: frame.bytes.slice(),
        }),
      onSessionReady: (session) => options?.readySessions?.push(session.id),
      onSocketClose: (close) => options?.closes?.push(close),
    });
    proxies.push(proxy);
    return { provider, proxy };
  }

  test("observes the exact PCM accepted at both userspace wire boundaries", async () => {
    /*
     * A nearby room microphone can prove audibility, but it cannot tell us
     * whether corruption entered before Grok or after Grok. The local
     * userspace harness therefore needs a non-blocking tee at the two public
     * PCM boundaries: bytes accepted for provider uplink and bytes accepted
     * for device downlink. The observer receives owned copies in this test so
     * later ring-buffer reuse cannot make a retained artifact lie.
     */
    const pcmFrames: PcmFrameObservation[] = [];
    const downlinkCompletions: number[] = [];
    const { provider, proxy } = createProxy({
      downlinkCompletions,
      minimumDownlinkStartupFrames: 1,
      pcmFrames,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const microphoneFrame = new Uint8Array(frameBytes).fill(0x31);
    const speakerFrame = new Uint8Array(frameBytes).fill(0x72);
    device.send(microphoneFrame);
    provider.client.send(speakerFrame);
    provider.client.send(JSON.stringify({ type: "response.done" }));

    await vi.waitFor(() => {
      expect(pcmFrames).toHaveLength(2);
      expect(downlinkCompletions).toHaveLength(1);
    });
    expect(pcmFrames).toEqual([
      {
        bytes: microphoneFrame,
        direction: "microphone-uplink",
        observedAtMonotonicMs: expect.any(Number),
      },
      {
        bytes: speakerFrame,
        direction: "speaker-downlink",
        observedAtMonotonicMs: expect.any(Number),
      },
    ]);
  });

  test("rejects missing or invalid project bearer credentials before provider egress", async () => {
    let connectionAttempts = 0;
    const proxy = new DevicePcmProxy({
      authenticate: () => false,
      connectProvider: async () => {
        connectionAttempts += 1;
        return socketPair().server;
      },
      frameBytes,
    });
    proxies.push(proxy);

    await expect(
      proxy.fetch(
        new Request("https://local.invalid/pcm", {
          headers: {
            "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL,
            upgrade: "websocket",
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(proxy.fetch(pcmRequest({ token: "wrong" }))).resolves.toMatchObject({
      status: 401,
    });
    expect(connectionAttempts).toBe(0);
  });

  test("accepts bearer transport in either Authorization or a non-echoed subprotocol", async () => {
    for (const tokenInProtocol of [false, true]) {
      const { proxy } = createProxy();
      const response = await proxy.fetch(pcmRequest({ tokenInProtocol }));
      expect(response.status).toBe(200);
      expect(response.headers.get("sec-websocket-protocol")).toBe(ITERATE_KIT_PCM_SUBPROTOCOL);
      expect((response as Response & { webSocket?: WebSocket }).webSocket).toBeDefined();
    }
  });

  test("reports a PCM session only after both device and provider sockets are ready", async () => {
    const readySessions: string[] = [];
    const { proxy } = createProxy({ readySessions });

    expect(readySessions).toEqual([]);
    const response = await proxy.fetch(pcmRequest());

    expect(response.status).toBe(200);
    expect((response as Response & { webSocket?: WebSocket }).webSocket).toBeDefined();
    expect(readySessions).toEqual([projectId]);
  });

  test("accepts the non-secret project ID in the URL for standards-based WebSocket clients", async () => {
    const { proxy } = createProxy();
    const response = await proxy.fetch(
      new Request(`https://local.invalid/pcm?projectId=${encodeURIComponent(projectId)}`, {
        headers: {
          "sec-websocket-protocol": [
            ITERATE_KIT_PCM_SUBPROTOCOL,
            projectBearerSubprotocol(projectToken),
          ].join(", "),
          upgrade: "websocket",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("sec-websocket-protocol")).toBe(ITERATE_KIT_PCM_SUBPROTOCOL);
  });

  test("relays exact uplink frames and rechunks provider downlink without forwarding JSON events", async () => {
    const events: ProviderVoiceEvent[] = [];
    const { provider, proxy } = createProxy({
      events,
      /*
       * This small contract test is intentionally about byte reassembly, not
       * the production startup reservoir exercised below.
       */
      minimumDownlinkStartupFrames: 1,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    expect(device).toBeDefined();
    device?.accept();
    if (!device) throw new Error("missing device WebSocket");
    sockets.push(device);

    const uplink = new Uint8Array(frameBytes);
    uplink[0] = 12;
    uplink[frameBytes - 1] = 34;
    const providerUplink = waitForMessage(provider.client);
    device.send(uplink);
    await expect(providerUplink).resolves.toMatchObject({ data: uplink });

    const firstDownlink = waitForMessage(device);
    provider.client.send(new Uint8Array(frameBytes + 100).fill(45));
    const firstFrame = await firstDownlink;
    expect(firstFrame.data).toEqual(new Uint8Array(frameBytes).fill(45));

    provider.client.send(
      JSON.stringify({
        transcript: "hello",
        type: "conversation.item.input_audio_transcription.updated",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([
      {
        raw: JSON.stringify({
          transcript: "hello",
          type: "conversation.item.input_audio_transcription.updated",
        }),
        type: "conversation.item.input_audio_transcription.updated",
      },
    ]);

    const paddedDownlink = waitForMessage(device);
    provider.client.send(JSON.stringify({ type: "response.done" }));
    const paddedFrame = new Uint8Array((await paddedDownlink).data as Uint8Array);
    expect(paddedFrame).toHaveLength(frameBytes);
    expect(paddedFrame.subarray(0, 100)).toEqual(new Uint8Array(100).fill(45));
    expect(paddedFrame.subarray(100)).toEqual(new Uint8Array(frameBytes - 100));
    expect(events.at(-1)?.type).toBe("response.done");
  });

  /*
   * `response.done` on a control socket cannot be ordered against PCM already
   * in flight. The device therefore needs an end marker on this same binary
   * lane, after the final frame, so one-frame prompts can stop cleanly instead
   * of waiting for more prebuffer or being misclassified as an underrun.
   */
  test("sends an ordered zero-length end marker after a finite PCM response", async () => {
    const { provider, proxy } = createProxy({
      minimumDownlinkStartupFrames: 1,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const received: MessageEvent[] = [];
    device.addEventListener("message", (event) => received.push(event));
    const frame = waitForMessage(device);
    provider.client.send(new Uint8Array(frameBytes).fill(17));
    await frame;
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(2);
    expect(received[0]?.data).toEqual(new Uint8Array(frameBytes).fill(17));
    expect(new Uint8Array(received[1]?.data as ArrayBufferLike)).toHaveLength(0);
  });

  test("commits a push-to-talk turn and explicitly requests the response", async () => {
    const { provider, proxy } = createProxy({
      inputMode: "push-to-talk",
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    await expect(proxy.inputStarted(projectId)).resolves.toBe(true);
    const relayed = waitForMessage(provider.client);
    device.send(new Uint8Array(frameBytes).fill(7));
    await expect(relayed).resolves.toMatchObject({
      data: new Uint8Array(frameBytes).fill(7),
    });

    const controls = waitForMessages(provider.client, 2);
    await expect(proxy.inputStopped(projectId)).resolves.toBe(true);
    await expect(
      controls.then((messages) => messages.map((message) => JSON.parse(String(message.data)))),
    ).resolves.toEqual([{ type: "input_audio_buffer.commit" }, { type: "response.create" }]);
  });

  test("streams every microphone frame during a long button hold instead of buffering until release", async () => {
    const { provider, proxy } = createProxy({
      inputMode: "push-to-talk",
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    await expect(proxy.inputStarted(projectId)).resolves.toBe(true);
    const heldFrameCount = 500;
    const relayedFrames = waitForMessages(provider.client, heldFrameCount);
    for (let index = 0; index < heldFrameCount; index += 1) {
      const frame = new Uint8Array(frameBytes);
      frame[0] = index % 251;
      frame[frameBytes - 1] = (index + 1) % 251;
      device.send(frame);
    }

    const framesReceivedBeforeRelease = await relayedFrames;
    expect(framesReceivedBeforeRelease).toHaveLength(heldFrameCount);
    expect(new Uint8Array(framesReceivedBeforeRelease[0]?.data as ArrayBufferLike)[0]).toBe(0);
    expect(
      new Uint8Array(framesReceivedBeforeRelease.at(-1)?.data as ArrayBufferLike)[frameBytes - 1],
    ).toBe(heldFrameCount % 251);

    const releaseControls = waitForMessages(provider.client, 2);
    await expect(proxy.inputStopped(projectId)).resolves.toBe(true);
    await expect(
      releaseControls.then((messages) =>
        messages.map((message) => JSON.parse(String(message.data))),
      ),
    ).resolves.toEqual([{ type: "input_audio_buffer.commit" }, { type: "response.create" }]);
  });

  test("requests a provider text turn without sending microphone audio", async () => {
    const { provider, proxy } = createProxy({
      inputMode: "push-to-talk",
      minimumDownlinkStartupFrames: 1,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const controls = waitForMessages(provider.client, 2);
    await expect(
      proxy.requestTextResponse(projectId, "Say exactly: Grok audio reached the Stick."),
    ).resolves.toBe(true);
    await expect(
      controls.then((messages) => messages.map((message) => JSON.parse(String(message.data)))),
    ).resolves.toEqual([
      {
        item: {
          content: [
            {
              text: "Say exactly: Grok audio reached the Stick.",
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

    provider.client.send(JSON.stringify({ type: "response.created" }));
    const downlink = waitForMessage(device);
    provider.client.send(new Uint8Array(frameBytes).fill(29));
    await expect(downlink).resolves.toMatchObject({
      data: new Uint8Array(frameBytes).fill(29),
    });
  });

  test("an interrupted push-to-talk turn cancels and suppresses stale provider audio", async () => {
    const { provider, proxy } = createProxy({
      inputMode: "push-to-talk",
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    provider.client.send(JSON.stringify({ type: "response.created" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancellation = waitForMessage(provider.client);
    await expect(proxy.inputStarted(projectId)).resolves.toBe(true);
    await expect(cancellation.then((message) => JSON.parse(String(message.data)))).resolves.toEqual(
      { type: "response.cancel" },
    );

    let staleFrames = 0;
    device.addEventListener("message", () => {
      staleFrames += 1;
    });
    provider.client.send(new Uint8Array(frameBytes).fill(9));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(staleFrames).toBe(0);
  });

  test("paces provider audio at one device frame per frame duration", async () => {
    const { provider, proxy } = createProxy();
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const receivedAt: number[] = [];
    device.addEventListener("message", () => {
      receivedAt.push(performance.now());
    });
    const firstFrame = waitForMessage(device);
    provider.client.send(new Uint8Array(frameBytes * 3).fill(6));

    await firstFrame;
    expect(receivedAt).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(receivedAt).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receivedAt).toHaveLength(2);
  });

  test("sustains the physical endurance source without overflowing or truncating it", async () => {
    /*
     * The physical Stick proof deliberately uses 1,000-byte provider chunks so
     * neither the fixture nor the proxy can accidentally rely on the device's
     * convenient 640-byte boundary. The first one-minute run became audible
     * for only about 128 ms and then the PCM generation reconnected. Replaying
     * these exact rates against the real provider and proxy classes gives that
     * failure a seconds-fast host seam: all 60 seconds must emerge as exactly
     * 3,000 ordered device frames, followed by the in-band end marker, without
     * relaxing the 160 ms realtime queue bound.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const providerEvents: ProviderVoiceEvent[] = [];
    const provider = new DeterministicPcmToneProvider({
      amplitude: 24_576,
      chunkBytes: 1_000,
      durationMs: 60_000,
      frequencyHz: 997,
      sampleRateHz: 16_000,
    });
    const proxy = new DevicePcmProxy({
      authenticate: () => true,
      connectProvider: () => provider.connect(),
      frameBytes,
      onFailure: (reason) => failures.push(reason),
      onProviderEvent: (event) => providerEvents.push(event),
      resolveSession: (_request, id) => ({ id, inputMode: "push-to-talk" }),
    });
    proxies.push(proxy);

    try {
      const response = await proxy.fetch(pcmRequest());
      const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
      if (!device) throw new Error("missing device WebSocket");
      device.accept();
      sockets.push(device);
      const frameFirstSamples: number[] = [];
      const frameReceivedAtMs: number[] = [];
      const pcmSha256 = createHash("sha256");
      let endMarkers = 0;
      device.addEventListener("message", (event) => {
        const bytes = new Uint8Array(event.data as ArrayBufferLike);
        if (bytes.byteLength === 0) {
          endMarkers += 1;
          return;
        }
        pcmSha256.update(bytes);
        frameFirstSamples.push(new DataView(bytes.buffer, bytes.byteOffset).getInt16(0, true));
        frameReceivedAtMs.push(performance.now());
      });

      await expect(
        proxy.requestTextResponse(projectId, "play the endurance fixture"),
      ).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(60_100);

      expect(failures).toEqual([]);
      expect(providerEvents.map((event) => event.type)).toEqual([
        "response.created",
        "response.done",
      ]);
      expect(frameFirstSamples).toHaveLength(3_000);
      expect(frameFirstSamples.slice(0, 4)).toEqual([0, -9_047, -16_823, -22_237]);
      /*
       * Counting frames alone would accept a duplicate followed by a skip.
       * This fixed digest covers every emitted sample and therefore makes
       * reordering, padding, stale replay, and phase discontinuity observable.
       */
      expect(pcmSha256.digest("hex")).toBe(
        "f740bf139d3dd8962fd20491400eaea74eff84d7a84bdba247d38682b6a8c80f",
      );
      /*
       * Exact bytes can still sound broken. With 1,000-byte source messages, a
       * proxy that starts after the first 640 bytes repeatedly runs dry before
       * the next 31.25 ms source chunk and emits a 31/9/23/... cadence. The
       * speaker then hears the same “jiggle” as the first physical endurance
       * run despite a perfect count and digest. After one explicit startup
       * phase, every complete frame must leave on the 20 ms media clock.
       */
      const frameGapsMs = frameReceivedAtMs
        .slice(1)
        .map((receivedAt, index) => receivedAt - (frameReceivedAtMs[index] ?? 0));
      expect(frameReceivedAtMs[0]).toBeGreaterThanOrEqual(20);
      /*
       * Fake timers quantize a fractional 31.25 ms source clock to integer
       * scheduling ticks, so an absolute 20 ms deadline can appear as 19 or
       * 20 ms. The old starvation sawtooth included roughly 31 ms and 9 ms
       * gaps; keeping every gap in this one-tick envelope proves it is gone.
       */
      expect(Math.min(...frameGapsMs)).toBeGreaterThanOrEqual(19);
      expect(Math.max(...frameGapsMs)).toBeLessThanOrEqual(20);
      expect(endMarkers).toBe(1);
    } finally {
      provider[Symbol.dispose]();
    }
  });

  test("fails a started generation at its first source underrun instead of resuming late", async () => {
    /*
     * Once playout has started, waiting for a later provider packet after the
     * 20 ms deadline produces an audible hole and shifts old speech into the
     * future. The tempting implementation simply stops arming timers while the
     * byte ring is short, then resumes when data appears. This test makes that
     * hidden latency illegal: the bounded startup reservoir may absorb jitter,
     * but exhausting it destroys and classifies the generation.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const { provider, proxy } = createProxy({ failures });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    provider.client.send(new Uint8Array(frameBytes * 3).fill(5));
    await vi.advanceTimersByTimeAsync(40);
    expect(failures).toEqual([]);

    await vi.advanceTimersByTimeAsync(20);
    expect(failures).toEqual(["provider-downlink-source-underrun"]);
  });

  test("lets the device clock consume bounded provider bursts without a second media timer", async () => {
    /*
     * The physical schema-4 discriminator measured only a 22.8 ms gap at the
     * host bridge but a 70 ms complete-frame gap at the Stick. A host timer
     * that releases exactly one frame every 20 ms consequently keeps the
     * device ring at depth zero or one: none of the nominal 80 ms startup
     * reserve is replenished after ordinary clock drift consumes it.
     *
     * In device-clocked mode, the proxy remains a bounded rechunker and lets
     * the provider's naturally bursty chunks refill the device-side ring.
     * There is deliberately no host "source underrun" timer. A provider pause
     * is classified at the actual playout boundary by the device, which owns
     * freshness and recovery, instead of destroying the socket one hop early.
     *
     * This test also guards the tempting unbounded implementation: the loop
     * may release only bytes already admitted by the existing fixed-capacity
     * queue, and later bytes must preserve exact order.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      downlinkDeliveryMode: "device-clocked",
      failures,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const frames: Uint8Array[] = [];
    const receivedAt: number[] = [];
    device.addEventListener("message", (event) => {
      const bytes = new Uint8Array(event.data as ArrayBufferLike);
      if (bytes.byteLength === 0) return;
      frames.push(bytes);
      receivedAt.push(performance.now());
    });

    const startup = new Uint8Array(frameBytes * 3);
    startup.fill(1, 0, frameBytes);
    startup.fill(2, frameBytes, frameBytes * 2);
    startup.fill(3, frameBytes * 2);
    provider.client.send(startup);
    await vi.advanceTimersByTimeAsync(0);

    expect(frames.map((frame) => frame[0])).toEqual([1, 2, 3]);
    expect(new Set(receivedAt)).toEqual(new Set([0]));

    await vi.advanceTimersByTimeAsync(200);
    expect(failures).toEqual([]);

    provider.client.send(new Uint8Array(frameBytes).fill(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.map((frame) => frame[0])).toEqual([1, 2, 3, 4]);
    expect(receivedAt.at(-1)).toBe(200);
  });

  test("separates the userspace source reservoir from the device startup lead", async () => {
    /*
     * A physical Grok cue exposed a 203.28 ms gap between provider packets.
     * The old implementation used the same eight-frame value both as the
     * source-jitter watermark and as the immediate burst sent to the Stick, so
     * there was no way to cover that gap without overflowing the device's
     * eight-frame realtime budget.
     *
     * The larger 32-frame / 640 ms reservoir belongs in userspace, where it is
     * bounded by the existing response allocation. The Stick still receives
     * exactly eight frames initially and one frame per media deadline. This
     * keeps ESP RAM and device latency fixed while provider packetization can
     * no longer starve a healthy speaker lane.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      deviceClockedInitialBurstFrames: 8,
      downlinkDeliveryMode: "device-clocked",
      failures,
      maximumDownlinkQueuedBytes: frameBytes * 64,
      minimumDownlinkStartupFrames: 32,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const frameFirstBytes: number[] = [];
    device.addEventListener("message", (event) => {
      const bytes = new Uint8Array(event.data as ArrayBufferLike);
      if (bytes.byteLength > 0) frameFirstBytes.push(bytes[0] ?? 0);
    });

    for (let frame = 1; frame <= 31; frame += 1) {
      provider.client.send(new Uint8Array(frameBytes).fill(frame));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(frameFirstBytes).toEqual([]);

    provider.client.send(new Uint8Array(frameBytes).fill(32));
    await vi.advanceTimersByTimeAsync(0);
    expect(frameFirstBytes).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    await vi.advanceTimersByTimeAsync(203);
    expect(frameFirstBytes).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(failures).toEqual([]);

    provider.client.send(new Uint8Array(frameBytes).fill(33));
    await vi.advanceTimersByTimeAsync(17);
    expect(frameFirstBytes).toEqual(Array.from({ length: 19 }, (_, index) => index + 1));
    expect(failures).toEqual([]);
  });

  test("starts a completed short response without waiting for the source reservoir", async () => {
    /*
     * A large source reservoir must not turn a short acknowledgement into
     * 640 ms of avoidable silence. `response.done` proves that no additional
     * source bytes are coming, so a finite short response may prime only the
     * frames it actually contains and then emit its ordered end marker.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      deviceClockedInitialBurstFrames: 8,
      downlinkDeliveryMode: "device-clocked",
      failures,
      minimumDownlinkStartupFrames: 32,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const received: Uint8Array[] = [];
    device.addEventListener("message", (event) => {
      received.push(new Uint8Array(event.data as ArrayBufferLike));
    });
    provider.client.send(new Uint8Array(frameBytes * 5 + 100).fill(41));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([]);

    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(0);

    const pcmFrames = received.filter((frame) => frame.byteLength > 0);
    expect(pcmFrames).toHaveLength(6);
    expect(pcmFrames.at(-1)?.subarray(0, 100)).toEqual(new Uint8Array(100).fill(41));
    expect(pcmFrames.at(-1)?.subarray(100)).toEqual(new Uint8Array(frameBytes - 100));
    expect(received.filter((frame) => frame.byteLength === 0)).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  test("rejects a device startup burst larger than its source watermark", () => {
    /*
     * Letting the immediate device burst exceed the source watermark silently
     * collapses the two independent budgets again: the proxy could begin with
     * fewer source frames than the requested hardware lead. Rejecting this at
     * construction keeps every accepted configuration mechanically coherent.
     */
    expect(
      () =>
        new DevicePcmProxy({
          authenticate: () => true,
          connectProvider: async () => socketPair().server,
          deviceClockedInitialBurstFrames: 9,
          downlinkDeliveryMode: "device-clocked",
          frameBytes,
          minimumDownlinkStartupFrames: 8,
        }),
    ).toThrow("device-clocked initial burst must not exceed the source startup reservoir");
  });

  test("paces real Grok packet bursts through the device-clocked PCM seam", async () => {
    /*
     * A live grok-voice-think-fast-2.0 probe returned a 1.59-second spoken
     * response as five messages of 7,830, 20,552, 9,788, 8,808, and 3,910
     * bytes within 235 ms. Those are provider packet boundaries, not 20 ms
     * playout deadlines. Rejecting the first message because it exceeds the
     * device's short startup lead makes a healthy provider look like realtime
     * backlog; forwarding all five immediately merely moves that backlog into
     * the Stick and its TCP buffers.
     *
     * The public provider-to-device WebSocket seam must instead prime exactly
     * the configured seven-frame hardware lead, pace the remaining complete
     * frames, preserve bytes across every odd packet boundary, and pad only
     * the final response tail. This literal packet trace is independent of the
     * rechunking implementation and reproduces the physical failure which sent
     * zero response frames to the Stick.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      downlinkDeliveryMode: "device-clocked",
      failures,
      minimumDownlinkStartupFrames: 7,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const messages = [7_830, 20_552, 9_788, 8_808, 3_910].map((byteLength, messageIndex) =>
      new Uint8Array(byteLength).fill(messageIndex + 1),
    );
    const received: Uint8Array[] = [];
    device.addEventListener("message", (event) => {
      received.push(new Uint8Array(event.data as ArrayBufferLike));
    });

    for (const message of messages) provider.client.send(message);
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(received.slice(0, 7).map((frame) => frame.byteLength)).toEqual(
      Array.from({ length: 7 }, () => frameBytes),
    );
    expect(failures).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);

    const pcmFrames = received.filter((frame) => frame.byteLength > 0);
    const endMarkers = received.filter((frame) => frame.byteLength === 0);
    const expectedBytes = Buffer.concat(messages.map((message) => Buffer.from(message)));
    const actualBytes = Buffer.concat(pcmFrames.map((frame) => Buffer.from(frame)));
    expect(pcmFrames).toHaveLength(Math.ceil(expectedBytes.byteLength / frameBytes));
    expect(actualBytes.subarray(0, expectedBytes.byteLength)).toEqual(expectedBytes);
    expect(actualBytes.subarray(expectedBytes.byteLength).every((byte) => byte === 0)).toBe(true);
    expect(endMarkers).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  test("accepts a real Grok packet larger than the former arbitrary message cap", async () => {
    /*
     * The longer physical joke run was cut off after "Why don't scie-" even
     * though the Stick, LAN, and paced downlink were healthy. A direct replay
     * of that exact prompt then measured one 73,400-byte Grok binary message.
     * Provider packetization has no realtime meaning: this message fits the
     * existing bounded userspace reservoir and therefore
     * must be rechunked through it, not rejected by an unrelated 64 KiB cap.
     *
     * The queue remains the hard memory and freshness bound. This test does
     * not permit a packet larger than the reservoir or relax odd-byte PCM
     * validation; it prevents those distinct policies from being conflated.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      downlinkDeliveryMode: "device-clocked",
      failures,
      minimumDownlinkStartupFrames: 7,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const providerMessage = new Uint8Array(73_400);
    for (let index = 0; index < providerMessage.byteLength; index += 1) {
      providerMessage[index] = index % 251;
    }
    const received: Uint8Array[] = [];
    device.addEventListener("message", (event) => {
      received.push(new Uint8Array(event.data as ArrayBufferLike));
    });

    provider.client.send(providerMessage);
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(3_000);

    const pcmFrames = received.filter((frame) => frame.byteLength > 0);
    const actualBytes = Buffer.concat(pcmFrames.map((frame) => Buffer.from(frame)));
    expect(actualBytes.subarray(0, providerMessage.byteLength)).toEqual(
      Buffer.from(providerMessage),
    );
    expect(received.filter((frame) => frame.byteLength === 0)).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  test("retains one complete observed Grok response burst within the userspace budget", async () => {
    /*
     * Fixing the former 64 KiB per-message guard exposed the next independent
     * limit: the exact joke response which crossed that guard contained
     * 148,222 bytes across seven messages. xAI produced those 4.63 seconds of
     * PCM in under one second, so a 128,000-byte reservoir could accept the
     * largest individual message yet still disconnect halfway through the
     * response as the following messages arrived.
     *
     * WebSocket receive events offer no useful application backpressure once
     * a binary message has been delivered. The smallest honest MVP contract is
     * therefore one explicit, bounded userspace response budget large enough
     * for the production trace, while the ESP keeps only its short realtime
     * lead. Interruption still destroys this reservoir immediately; this test
     * permits neither stale replay nor an unbounded conversation queue.
     */
    vi.useFakeTimers();
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      downlinkDeliveryMode: "device-clocked",
      failures,
      minimumDownlinkStartupFrames: 8,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const messages = [7_830, 20_552, 14_680, 18_596, 73_400, 9_788, 3_376].map(
      (byteLength, messageIndex) => {
        const message = new Uint8Array(byteLength);
        for (let index = 0; index < message.byteLength; index += 1) {
          message[index] = (index + messageIndex * 31) % 251;
        }
        return message;
      },
    );
    const received: Uint8Array[] = [];
    device.addEventListener("message", (event) => {
      received.push(new Uint8Array(event.data as ArrayBufferLike));
    });

    /*
     * Delivery cadence is intentionally the worst legal case. The production
     * timings are evidence, not a provider promise, and JS cannot make later
     * callbacks wait for the speaker clock. A reservoir advertised as a
     * complete-response budget must admit the same bytes even if the runtime
     * dispatches their already-generated messages in one task turn.
     */
    for (const message of messages) provider.client.send(message);
    provider.client.send(JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(5_000);

    const pcmFrames = received.filter((frame) => frame.byteLength > 0);
    const expectedBytes = Buffer.concat(messages.map((message) => Buffer.from(message)));
    const actualBytes = Buffer.concat(pcmFrames.map((frame) => Buffer.from(frame)));
    expect(actualBytes.subarray(0, expectedBytes.byteLength)).toEqual(expectedBytes);
    expect(actualBytes.subarray(expectedBytes.byteLength).every((byte) => byte === 0)).toBe(true);
    expect(received.filter((frame) => frame.byteLength === 0)).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  /*
   * A provider can briefly outrun the 20 ms device pacer, but preserving ten
   * seconds of speech turns a recovered radio into a delayed conversation.
   * Eight frames are the explicit 160 ms jitter allowance; the ninth must end
   * this PCM generation visibly so reconnect starts from current speech.
   */
  test("rejects provider audio beyond a configured realtime response budget", async () => {
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      failures,
      maximumDownlinkQueuedBytes: frameBytes * 8,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    provider.client.send(new Uint8Array(frameBytes * 9).fill(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failures).toContain("provider-pcm-message-budget-exceeded");
  });

  /*
   * Blob conversion is asynchronous. Chaining every WebSocket event behind a
   * slow first Blob retains every later payload before the byte-ring limit can
   * see it, so an attacker or stalled runtime can consume unbounded heap. The
   * ingress seam gets one in-flight conversion and must close deterministically
   * when another ordered message arrives instead of building a hidden queue.
   */
  test("bounds provider messages before asynchronous Blob conversion", async () => {
    const failures: string[] = [];
    const provider = new StrictCloseWebSocket();
    const proxy = new DevicePcmProxy({
      authenticate: () => true,
      connectProvider: async () => provider as unknown as WebSocket,
      frameBytes,
      onFailure: (reason) => failures.push(reason),
    });
    proxies.push(proxy);
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    const blocked = new DeferredBlob(new Uint8Array(frameBytes).fill(1));
    provider.dispatchEvent(new MessageEvent("message", { data: blocked }));
    for (let index = 0; index < 1_000; index += 1) {
      provider.dispatchEvent(
        new MessageEvent("message", {
          data: new Uint8Array(frameBytes).fill(index % 251).buffer,
        }),
      );
    }
    await Promise.resolve();

    expect(failures).toContain("provider-ingress-mailbox-overflow");
    expect(provider.closeCodes).toContain(4013);
    blocked.release();
  });

  test("closes explicitly instead of growing an unbounded downlink queue", async () => {
    const failures: string[] = [];
    const { provider, proxy } = createProxy({
      failures,
      maximumDownlinkQueuedBytes: frameBytes * 2,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    provider.client.send(new Uint8Array(frameBytes * 3));
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(failures).toContain("provider-pcm-message-budget-exceeded");
  });

  test("closes both lanes on text uplink or a non-frame-sized device message", async () => {
    for (const invalid of ["not Cap'n Web either", new Uint8Array(2)]) {
      const { provider, proxy } = createProxy();
      const response = await proxy.fetch(pcmRequest());
      const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
      if (!device) throw new Error("missing device WebSocket");
      device.accept();
      sockets.push(device);
      const deviceClosed = waitForClose(device);
      const providerClosed = waitForClose(provider.client);

      device.send(invalid);

      await expect(deviceClosed).resolves.toMatchObject({ code: 4002 });
      await expect(providerClosed).resolves.toMatchObject({ code: 4002 });
    }
  });

  test("shuts down provider sockets using a WebSocket-valid close code", async () => {
    const provider = new StrictCloseWebSocket();
    const proxy = new DevicePcmProxy({
      authenticate: () => true,
      connectProvider: async () => provider as unknown as WebSocket,
      frameBytes,
    });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);

    expect(() => proxy[Symbol.dispose]()).not.toThrow();
    expect(provider.closeCodes).toEqual([1000]);
  });

  /*
   * A reconnect only restores realtime conversation if the previous
   * generation leaves a precise explanation. The physical 60-second run
   * previously retained only "the socket reconnected", which made a provider
   * timeout, device Wi-Fi loss, and application rejection indistinguishable.
   * Preserve origin, wire code, and peer reason before relaying the close;
   * callers can then durably attach the exact failure to an endurance run
   * without parsing a high-cardinality log string.
   */
  test("reports exact provider close provenance before ending the generation", async () => {
    const closes: DevicePcmSocketClose[] = [];
    const { provider, proxy } = createProxy({ closes });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);
    const deviceClosed = waitForClose(device);

    provider.client.close(4003, "provider stalled for 5s");

    await expect(deviceClosed).resolves.toMatchObject({
      code: 4003,
      reason: "PCM counterpart disconnected unexpectedly.",
    });
    expect(closes).toEqual([
      {
        classification: "unexpected",
        code: 4003,
        origin: "provider",
        reason: "provider stalled for 5s",
        wasClean: undefined,
      },
    ]);
  });

  test("classifies a normal device close without manufacturing a failure", async () => {
    const closes: DevicePcmSocketClose[] = [];
    const failures: string[] = [];
    const { provider, proxy } = createProxy({ closes, failures });
    const response = await proxy.fetch(pcmRequest());
    const device = (response as Response & { webSocket?: AcceptingWebSocket }).webSocket;
    if (!device) throw new Error("missing device WebSocket");
    device.accept();
    sockets.push(device);
    const providerClosed = waitForClose(provider.client);

    device.close(1000, "endurance stage complete");

    await expect(providerClosed).resolves.toMatchObject({
      code: 1000,
      reason: "endurance stage complete",
    });
    expect(failures).toEqual([]);
    expect(closes).toEqual([
      {
        classification: "normal",
        code: 1000,
        origin: "device",
        reason: "endurance stage complete",
        wasClean: undefined,
      },
    ]);
  });
});
