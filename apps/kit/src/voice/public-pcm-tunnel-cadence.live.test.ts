import { createHash } from "node:crypto";
import { createCaptunTunnel, type CaptunTunnel } from "captun";
import { afterEach, describe, expect, test } from "vitest";
import { DeterministicPcmToneProvider } from "./deterministic-pcm-tone-provider.ts";
import {
  DevicePcmProxy,
  ITERATE_KIT_PCM_SUBPROTOCOL,
  projectBearerSubprotocol,
} from "./device-pcm-proxy.ts";

const durationMs = 60_000;
const frameBytes = 640;
const frameDurationMs = 20;
const expectedFrameCount = durationMs / frameDurationMs;
const projectId = "prj_public_pcm_cadence";
const projectToken = "itxk-public-pcm-cadence";

function waitForOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out opening the public PCM WebSocket.")),
      10_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("The public PCM WebSocket failed to open."));
      },
      { once: true },
    );
  });
}

interface PublicPcmObservation {
  bytes: number;
  endMarkers: number;
  frameReceivedAtMs: number[];
  frames: number;
  sha256: string;
}

function observeResponse(socket: WebSocket) {
  return new Promise<PublicPcmObservation>((resolve, reject) => {
    const pcmSha256 = createHash("sha256");
    const frameReceivedAtMs: number[] = [];
    let bytes = 0;
    let endMarkers = 0;
    let frames = 0;
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for public PCM EOS after ${frames}/${expectedFrameCount} frames.`,
          ),
        ),
      durationMs + 15_000,
    );
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        clearTimeout(timeout);
        reject(new Error("The public PCM WebSocket delivered a non-ArrayBuffer frame."));
        return;
      }
      const frame = new Uint8Array(event.data);
      if (frame.byteLength === 0) {
        endMarkers += 1;
        clearTimeout(timeout);
        resolve({
          bytes,
          endMarkers,
          frameReceivedAtMs,
          frames,
          sha256: pcmSha256.digest("hex"),
        });
        return;
      }
      bytes += frame.byteLength;
      frames += 1;
      pcmSha256.update(frame);
      frameReceivedAtMs.push(performance.now());
    });
    socket.addEventListener(
      "close",
      (event) => {
        if (endMarkers === 0) {
          clearTimeout(timeout);
          reject(
            new Error(`The public PCM WebSocket closed before EOS: ${event.code} ${event.reason}`),
          );
        }
      },
      { once: true },
    );
  });
}

const runLiveTunnelTest = process.env.ITERATE_KIT_LIVE_TUNNEL_TEST === "1";

/*
 * This is deliberately an opt-in live test. A fake WebSocketPair proves the
 * proxy's byte ordering and its own media clock, but it cannot expose queues
 * retained by the public tunnel's Cap'n Web bridge. Run it through Doppler:
 *
 *   ITERATE_KIT_LIVE_TUNNEL_TEST=1 \
 *     doppler run --project kit --config dev_jonas -- \
 *     pnpm exec vitest run --config vitest.config.ts \
 *       src/voice/public-pcm-tunnel-cadence.live.test.ts
 *
 * The seam is exactly the one the physical device sees: a standards-based
 * public WebSocket receiving binary PCM after provider synthesis, proxy
 * rechunking, and the real tunnel. No ESP hardware is needed to keep this
 * transport regression reproducible.
 */
describe.skipIf(!runLiveTunnelTest)("public PCM tunnel cadence", () => {
  let deviceSocket: WebSocket | undefined;
  let provider: DeterministicPcmToneProvider | undefined;
  let proxy: DevicePcmProxy | undefined;
  let tunnel: CaptunTunnel | undefined;

  afterEach(() => {
    deviceSocket?.close();
    tunnel?.[Symbol.dispose]();
    proxy?.[Symbol.dispose]();
    provider?.[Symbol.dispose]();
  });

  test(
    "preserves the 20 ms media clock instead of delivering byte-perfect PCM in bursts",
    async () => {
      const captunToken = process.env.CAPTUN_TOKEN?.trim();
      if (!captunToken) {
        throw new Error("CAPTUN_TOKEN is required for the live public-tunnel cadence test.");
      }
      const failures: string[] = [];
      const sessionReady = Promise.withResolvers<void>();
      provider = new DeterministicPcmToneProvider({
        amplitude: 24_576,
        chunkBytes: 1_000,
        durationMs,
        frequencyHz: 997,
        sampleRateHz: 16_000,
      });
      proxy = new DevicePcmProxy({
        authenticate: (candidateProjectId, candidateToken) =>
          candidateProjectId === projectId && candidateToken === projectToken,
        connectProvider: () => provider?.connect() ?? Promise.reject(new Error("disposed")),
        frameBytes,
        onFailure: (reason) => failures.push(reason),
        onSessionReady: () => sessionReady.resolve(),
        resolveSession: () => ({ id: projectId, inputMode: "push-to-talk" }),
      });
      tunnel = await createCaptunTunnel({
        fetch: (request) => proxy?.fetch(request) ?? new Response("disposed", { status: 503 }),
        gateway: process.env.CAPTUN_GATEWAY ?? "https://tunnels.iterate.com",
        token: captunToken,
      });

      const publicPcmUrl = new URL("/pcm", tunnel.url);
      publicPcmUrl.protocol = "wss:";
      publicPcmUrl.searchParams.set("projectId", projectId);
      deviceSocket = new WebSocket(publicPcmUrl, [
        ITERATE_KIT_PCM_SUBPROTOCOL,
        projectBearerSubprotocol(projectToken),
      ]);
      deviceSocket.binaryType = "arraybuffer";
      await waitForOpen(deviceSocket);
      await sessionReady.promise;
      const observationPromise = observeResponse(deviceSocket);
      await expect(proxy.requestTextResponse(projectId, "play the cadence fixture")).resolves.toBe(
        true,
      );
      const observation = await observationPromise;

      /*
       * These assertions intentionally come before cadence. They retain the
       * surprising failure mode: the current tunnel produces every correct
       * byte and EOS, yet still makes realtime playback unsafe.
       */
      expect(failures).toEqual([]);
      expect(observation.frames).toBe(expectedFrameCount);
      expect(observation.bytes).toBe(expectedFrameCount * frameBytes);
      expect(observation.endMarkers).toBe(1);
      expect(observation.sha256).toBe(
        "f740bf139d3dd8962fd20491400eaea74eff84d7a84bdba247d38682b6a8c80f",
      );

      const chronologicalGapsMs = observation.frameReceivedAtMs
        .slice(1)
        .map(
          (receivedAt, index) => receivedAt - (observation.frameReceivedAtMs[index] ?? receivedAt),
        );
      const sortedGapsMs = [...chronologicalGapsMs].sort((left, right) => left - right);
      const compressedGapCount = chronologicalGapsMs.filter(
        (gapMs) => gapMs < frameDurationMs - 10,
      ).length;
      const lateGapCount = chronologicalGapsMs.filter(
        (gapMs) => gapMs > frameDurationMs + 10,
      ).length;
      /*
       * The Stick starts direct I²S only after four fresh descriptors exist.
       * Frame N must therefore arrive no later than its sample-time deadline
       * relative to that fourth-frame start. This is a deliberately
       * conservative receiver model: it ignores the driver's real refill-lead
       * requirement, so a negative value is unambiguously too late even for
       * an ideal zero-cost firmware implementation.
       */
      const playbackStartedAtMs = observation.frameReceivedAtMs[3];
      if (playbackStartedAtMs === undefined) {
        throw new Error("The public PCM response did not contain the four-frame prebuffer.");
      }
      const fourFramePlayoutLeadMs = observation.frameReceivedAtMs
        .slice(4)
        .map(
          (receivedAt, index) => playbackStartedAtMs + (index + 4) * frameDurationMs - receivedAt,
        );
      const minimumFourFramePlayoutLeadMs = Math.min(...fourFramePlayoutLeadMs);
      const firstLateFrameIndex = fourFramePlayoutLeadMs.findIndex((leadMs) => leadMs < 0);
      const summary = {
        compressedGapCount,
        firstLateFrame: firstLateFrameIndex === -1 ? undefined : firstLateFrameIndex + 5,
        lateGapCount,
        maximumGapMs: sortedGapsMs.at(-1),
        minimumFourFramePlayoutLeadMs,
        minimumGapMs: sortedGapsMs[0],
        p50GapMs: sortedGapsMs[Math.floor(sortedGapsMs.length * 0.5)],
        p95GapMs: sortedGapsMs[Math.floor(sortedGapsMs.length * 0.95)],
        p99GapMs: sortedGapsMs[Math.floor(sortedGapsMs.length * 0.99)],
      };
      const failureContext = JSON.stringify(summary, undefined, 2);

      /*
       * Ten milliseconds either side is intentionally much wider than the
       * local proxy's observed 16.4–23.2 ms range. It admits ordinary host and
       * TCP scheduling noise, but not a transport that repeatedly holds calls
       * and then releases several 20 ms media frames in one event-loop turn.
       * Allowing one outlier keeps the live gate honest without turning a
       * single GC or radio scheduling event into the architecture verdict.
       */
      expect(minimumFourFramePlayoutLeadMs, failureContext).toBeGreaterThanOrEqual(0);
      expect(compressedGapCount, failureContext).toBeLessThanOrEqual(1);
      expect(lateGapCount, failureContext).toBeLessThanOrEqual(1);
    },
    durationMs + 30_000,
  );
});
