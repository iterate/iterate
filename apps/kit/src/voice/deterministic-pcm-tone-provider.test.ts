import { afterEach, describe, expect, test, vi } from "vitest";
import { DeterministicPcmToneProvider } from "./deterministic-pcm-tone-provider.ts";

describe("deterministic PCM tone provider", () => {
  const providers: DeterministicPcmToneProvider[] = [];

  afterEach(() => {
    for (const provider of providers.splice(0)) provider[Symbol.dispose]();
    vi.useRealTimers();
  });

  test("emits a known PCM16LE waveform through the same WebSocket contract as a voice provider", async () => {
    const provider = new DeterministicPcmToneProvider({
      amplitude: 16_384,
      chunkBytes: 1_000,
      durationMs: 100,
      frequencyHz: 1_000,
      sampleRateHz: 16_000,
    });
    providers.push(provider);
    const socket = await provider.connect();
    const messages: MessageEvent[] = [];
    const complete = Promise.withResolvers<void>();
    socket.addEventListener("message", (event) => {
      messages.push(event);
      if (typeof event.data === "string" && JSON.parse(event.data).type === "response.done") {
        complete.resolve();
      }
    });

    socket.send(JSON.stringify({ type: "response.create" }));
    await complete.promise;

    const controls = messages
      .filter((message) => typeof message.data === "string")
      .map((message) => JSON.parse(String(message.data)).type);
    const chunks = messages
      .filter((message) => typeof message.data !== "string")
      .map((message) => new Uint8Array(message.data as ArrayBufferLike));
    expect(controls).toEqual(["response.created", "response.done"]);
    expect(chunks.every((chunk) => chunk.byteLength <= 1_000)).toBe(true);

    const pcm = new Uint8Array(3_200);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(offset).toBe(pcm.byteLength);
    const samples = new DataView(pcm.buffer);
    expect(samples.getInt16(0, true)).toBe(0);
    expect(samples.getInt16(4 * 2, true)).toBe(16_384);
    expect(samples.getInt16(8 * 2, true)).toBe(0);
    expect(samples.getInt16(12 * 2, true)).toBe(-16_384);
  });

  test("paces a long fixture incrementally instead of manufacturing a proxy backlog", async () => {
    /*
     * The endurance fixture used to allocate the whole response and synchronously
     * fire every provider message. Ten minutes of 16 kHz PCM is 19.2 MB, which
     * overflowed the proxy's deliberately bounded queue before the first frame
     * could leave for the device. A real provider streams audio over time, so
     * this test protects both the fixture's constant-memory shape and the
     * production-relevant pacing seen by the proxy.
     */
    vi.useFakeTimers();
    const provider = new DeterministicPcmToneProvider({
      amplitude: 16_384,
      chunkBytes: 640,
      durationMs: 60_000,
      frequencyHz: 997,
      sampleRateHz: 16_000,
    });
    providers.push(provider);
    const socket = await provider.connect();
    const messages: MessageEvent[] = [];
    socket.addEventListener("message", (event) => messages.push(event));

    socket.send(JSON.stringify({ type: "response.create" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.filter((message) => typeof message.data !== "string")).toHaveLength(1);
    expect(
      messages.some(
        (message) =>
          typeof message.data === "string" && JSON.parse(message.data).type === "response.done",
      ),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(19);
    expect(messages.filter((message) => typeof message.data !== "string")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages.filter((message) => typeof message.data !== "string")).toHaveLength(2);
  });

  test("serves sequential diagnostic responses on one device PCM generation", async () => {
    /*
     * The physical AEC protocol alternates speaker-active and speaker-quiet
     * phases without reconnecting the device. A fixture which permanently
     * latches after response.done would force a reconnect between stimuli and
     * make the AEC state, socket counters, and network interval incomparable.
     */
    const provider = new DeterministicPcmToneProvider({
      amplitude: 12_000,
      chunkBytes: 640,
      durationMs: 40,
      frequencyHz: 997,
      sampleRateHz: 16_000,
    });
    providers.push(provider);
    const socket = await provider.connect();
    const controls: string[] = [];
    let completedResponses = 0;
    const bothComplete = Promise.withResolvers<void>();
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const type = JSON.parse(event.data).type as string;
      controls.push(type);
      if (type !== "response.done") return;
      completedResponses += 1;
      if (completedResponses === 1) {
        socket.send(JSON.stringify({ type: "response.create" }));
      } else {
        bothComplete.resolve();
      }
    });

    socket.send(JSON.stringify({ type: "response.create" }));
    await Promise.race([
      bothComplete.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Second deterministic response never started.")), 500),
      ),
    ]);

    expect(controls).toEqual([
      "response.created",
      "response.done",
      "response.created",
      "response.done",
    ]);
  });
});
