// 2026-09-02: an agent tried to write several 6MB images to script settlement values
// The incident mechanism was an unbounded journal replay after eviction: large
// persisted events could exceed the Stream processor facet's isolate memory and
// crash-loop the stream. This is now its deployed regression test.

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { Stream } from "../../src/itx-api.generated.ts";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

// Only against a deployed preview: the test deliberately evicts a stream after
// persisting ~84MB of journaled bodies. Local/unit runners cannot establish the
// Workers isolate memory boundary this guards.
const survivesReset = test.skipIf(deployedBaseUrl() === null);

survivesReset(
  "a stream survives being evicted after journaling oversized events",
  { timeout: 120_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`oversized-reset-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await using stream = withTestReset(project.streams.get("/"));

    // Six separately appended 14MB bodies exceed the former replay-memory
    // failure threshold while each append remains below Cap'n Web's 32MiB limit.
    const bigEvent = { type: "oversized-e2e/blob", payload: { blob: "x".repeat(14_000_000) } };
    const acceptedOffsets: number[] = [];
    for (let n = 0; n < 6; n++) {
      const [appended] = await stream.append(bigEvent);
      if (!appended) throw new Error(`oversized append ${n + 1} returned no event`);
      acceptedOffsets.push(appended.offset);
    }
    expect(acceptedOffsets).toHaveLength(6);

    // kill() aborts like a platform eviction, without touching storage. The isolate
    // may already be under memory pressure when this call arrives; the explicit
    // abort remains the expected control-plane outcome.
    await stream.kill().then(
      () => {
        throw new Error("kill() should reject with its own abort");
      },
      (error: unknown) => {
        if (!/kill requested/i.test(String(error))) throw error;
      },
    );

    // Read a few times. Each response is filtered to small wake facts, so this
    // exercises boot replay rather than a large response serialization.
    for (let read = 0; read < 3; read++) {
      const page = await stream.getEventPage({
        afterOffset: 0,
        limit: 500,
        eventTypes: ["events.iterate.com/stream/woken"],
      });
      expect(page.events, "the stream should wake twice: creation, then eviction").toHaveLength(2);
      expect(page.streamMaxOffset).toBeGreaterThanOrEqual(acceptedOffsets.at(-1)!);
    }

    // Read each persisted body separately after the cold boot. This proves all
    // six accepted events survived replay without creating an 84MB RPC response.
    const bodyHash = sha256(bigEvent.payload.blob);
    for (const offset of acceptedOffsets) {
      const payload = (await stream.getEvent({ offset }))?.payload;
      const blob = payload?.blob;
      if (typeof blob !== "string")
        throw new Error(`oversized event ${offset} has no string blob payload`);
      expect(blob).toHaveLength(14_000_000);
      expect(sha256(blob)).toBe(bodyHash);
    }
  },
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// --- helpers ---

/**
 * The stream, plus a best-effort wipe on dispose (testReset: deleteAll + abort;
 * its "kill requested" rejection is the success). Cleanup remains best-effort so
 * a teardown failure cannot bury the primary regression assertion.
 */
function withTestReset(stream: Stream): Stream & AsyncDisposable {
  const wipe = async () => {
    await (stream as unknown as { testReset(): Promise<void> })
      .testReset()
      .catch((error: unknown) => {
        if (/kill requested/i.test(String(error))) return;
        console.error("could not wipe test stream:", error);
      });
  };
  // Wrapped rather than assigned onto: the stream is an RPC stub proxy.
  return new Proxy(stream, {
    get: (target, key, receiver) =>
      key === Symbol.asyncDispose ? wipe : Reflect.get(target, key, receiver),
  }) as Stream & AsyncDisposable;
}
