import { describe, expect, test } from "vitest";
import { createDualCarrierPrbs31Challenge } from "../device/acoustic-prbs31-challenge.ts";
import { DeterministicPcmProvider } from "./deterministic-pcm-provider.ts";
import {
  createPrbs31Pcm16LeRenderer,
  createTonePcm16LeRenderer,
} from "./deterministic-pcm-renderers.ts";

describe("deterministic PCM provider", () => {
  test("can preserve fixture response order across deliberate provider reconnects", async () => {
    /*
     * The release matrix deliberately changes provider generations. Restarting
     * the WebSocket must not rewind the immutable 32-phase fixture sequence to
     * phase zero, otherwise the lifecycle test plays the wrong retained bytes
     * while its manifest still claims the intended phase.
     */
    const plannedIndices: number[] = [];
    const provider = new DeterministicPcmProvider({
      chunkBytes: 320,
      createResponse(responseIndex) {
        plannedIndices.push(responseIndex);
        return {
          durationMs: 20,
          renderer: createTonePcm16LeRenderer({
            amplitude: 1_000,
            frequencyHz: 997,
            sampleRateHz: 16_000,
          }),
        };
      },
      responseIndexScope: "provider",
      sampleRateHz: 16_000,
    });

    try {
      for (let connection = 0; connection < 2; connection += 1) {
        const socket = await provider.connect();
        const done = Promise.withResolvers<void>();
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          if ((JSON.parse(event.data) as { type: string }).type === "response.done") done.resolve();
        });
        socket.send(JSON.stringify({ type: "response.create" }));
        await done.promise;
        provider.retireConnections("matrix provider-generation-change");
      }
      expect(plannedIndices).toEqual([0, 1]);
    } finally {
      provider[Symbol.dispose]();
    }
  });

  test("creates an exact bounded source outage without replaying a catch-up burst", async () => {
    /*
     * Underrun/recovery qualification needs an intentional source gap whose
     * byte boundary and duration are known. Sending silence would exercise a
     * healthy transport, while pausing an arbitrary timer could split a sample
     * or accumulate overdue media deadlines. Recovery must continue from the
     * next exact sample at ordinary cadence.
     */
    const provider = new DeterministicPcmProvider({
      chunkBytes: 320,
      createResponse: () => ({
        durationMs: 40,
        renderer: {
          render(sampleCount) {
            return new Uint8Array(sampleCount * 2).fill(7);
          },
        },
        sourcePauses: [{ afterSamples: 160, durationMs: 50 }],
      }),
      sampleRateHz: 16_000,
    });
    try {
      const socket = await provider.connect();
      const receivedAtMs: number[] = [];
      let bytes = 0;
      const done = Promise.withResolvers<void>();
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          if ((JSON.parse(event.data) as { type: string }).type === "response.done") done.resolve();
          return;
        }
        bytes += event.data.byteLength;
        receivedAtMs.push(performance.now());
      });
      socket.send(JSON.stringify({ type: "response.create" }));
      await done.promise;

      expect(bytes).toBe(1_280);
      expect(receivedAtMs).toHaveLength(4);
      expect(receivedAtMs[1]! - receivedAtMs[0]!).toBeGreaterThanOrEqual(45);
      expect(receivedAtMs[2]! - receivedAtMs[1]!).toBeLessThan(25);
    } finally {
      provider[Symbol.dispose]();
    }
  });

  test("rejects a source pause outside the response instead of closing mid-fixture ambiguously", async () => {
    const provider = new DeterministicPcmProvider({
      chunkBytes: 320,
      createResponse: () => ({
        durationMs: 20,
        renderer: createTonePcm16LeRenderer({
          amplitude: 1_000,
          frequencyHz: 997,
          sampleRateHz: 16_000,
        }),
        sourcePauses: [{ afterSamples: 320, durationMs: 50 }],
      }),
      sampleRateHz: 16_000,
    });
    try {
      const socket = await provider.connect();
      const closed = Promise.withResolvers<CloseEvent>();
      socket.addEventListener("close", (event) => closed.resolve(event));
      socket.send(JSON.stringify({ type: "response.create" }));
      const event = await closed.promise;
      expect(event.code).toBe(1011);
      expect(event.reason).toBe("Deterministic provider stream failed.");
    } finally {
      provider[Symbol.dispose]();
    }
  });

  test("streams each planned matrix response for its own exact duration", async () => {
    /*
     * The release matrix mixes eight-second transients, two-minute speech,
     * and a ten-minute stability phase on one lifetime /pcm generation. A
     * provider-wide duration either truncates the long evidence or pads every
     * short phase with unrelated audio. Pin duration to the immutable response
     * plan while retaining one bounded streaming implementation.
     */
    const provider = new DeterministicPcmProvider({
      chunkBytes: 320,
      createResponse(responseIndex) {
        return {
          durationMs: responseIndex === 0 ? 20 : 40,
          renderer: createTonePcm16LeRenderer({
            amplitude: responseIndex === 0 ? 1_000 : 2_000,
            frequencyHz: 997,
            sampleRateHz: 16_000,
          }),
        };
      },
      sampleRateHz: 16_000,
    });

    try {
      const socket = await provider.connect();
      const bytesByResponse = [0, 0];
      const completed = Promise.withResolvers<void>();
      let activeResponse = -1;
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const control = JSON.parse(event.data) as { type: string };
          if (control.type === "response.created") activeResponse += 1;
          if (control.type === "response.done" && activeResponse === 0) {
            socket.send(JSON.stringify({ type: "response.create" }));
          } else if (control.type === "response.done") {
            completed.resolve();
          }
          return;
        }
        const byteLength =
          event.data instanceof ArrayBuffer ? event.data.byteLength : event.data.byteLength;
        bytesByResponse[activeResponse]! += byteLength;
      });
      socket.send(JSON.stringify({ type: "response.create" }));
      await completed.promise;

      expect(bytesByResponse).toEqual([640, 1_280]);
    } finally {
      provider[Symbol.dispose]();
    }
  });

  test("keeps one generation alive while a quiet physical PRBS phase follows a tone", async () => {
    /*
     * The physical AEC proof begins with a tone and then changes to PRBS on
     * the same provider WebSocket. Its first real run completed the tone but
     * disconnected precisely when PRBS should have started: the harness had
     * mutated a signed challenge to lower its acoustic volume, and renderer
     * construction therefore threw before response.created. This exercises
     * the production-shaped sequence—not merely the DSP helper—because a
     * phase-two factory error is otherwise observed at the device only as a
     * generic counterpart disconnect and reconnect/reset cascade.
     */
    const challenge = createDualCarrierPrbs31Challenge({ runId: "quiet-provider-sequence" });
    const provider = new DeterministicPcmProvider({
      chunkBytes: 640,
      createRenderer(responseIndex) {
        if (responseIndex === 0) {
          return createTonePcm16LeRenderer({
            amplitude: 5_000,
            frequencyHz: 997,
            sampleRateHz: 16_000,
          });
        }
        return createPrbs31Pcm16LeRenderer(challenge, {
          outputGain: 2_500 / challenge.carrierAmplitude,
        });
      },
      durationMs: 20,
      sampleRateHz: 16_000,
    });

    try {
      const socket = await provider.connect();
      const controls: string[] = [];
      const secondResponsePcm: Uint8Array[] = [];
      const complete = Promise.withResolvers<void>();
      let activeResponse = -1;
      let closeObserved = false;
      socket.addEventListener("close", () => {
        closeObserved = true;
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const decoded: unknown = JSON.parse(event.data);
          if (
            !decoded ||
            typeof decoded !== "object" ||
            !("type" in decoded) ||
            typeof decoded.type !== "string"
          ) {
            throw new Error("The deterministic provider emitted malformed control data.");
          }
          controls.push(decoded.type);
          if (decoded.type === "response.created") activeResponse += 1;
          if (decoded.type !== "response.done") return;
          if (activeResponse === 0) {
            socket.send(JSON.stringify({ type: "response.create" }));
          } else {
            complete.resolve();
          }
          return;
        }
        if (activeResponse !== 1) return;
        if (event.data instanceof Uint8Array) {
          secondResponsePcm.push(event.data.slice());
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          secondResponsePcm.push(new Uint8Array(event.data));
          return;
        }
        throw new Error("The deterministic provider emitted non-binary PCM.");
      });

      socket.send(JSON.stringify({ type: "response.create" }));
      await Promise.race([
        complete.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Quiet PRBS response never completed.")), 500),
        ),
      ]);

      let peak = 0;
      for (const chunk of secondResponsePcm) {
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (let byteOffset = 0; byteOffset < chunk.byteLength; byteOffset += 2) {
          peak = Math.max(peak, Math.abs(view.getInt16(byteOffset, true)));
        }
      }
      expect(controls).toEqual([
        "response.created",
        "response.done",
        "response.created",
        "response.done",
      ]);
      expect(closeObserved).toBe(false);
      expect(challenge.carrierAmplitude).toBe(9_175);
      expect(peak).toBeGreaterThan(2_500);
      expect(peak).toBeLessThanOrEqual(5_000);
    } finally {
      provider[Symbol.dispose]();
    }
  });
});
