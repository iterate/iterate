// 2026-09-02: an agent tried to write several 6MB images to script settlement values
// The incident, reduced to its mechanism: large events in a stream's
// journal do not hurt the incarnation that appends them, but the next incarnation
// replays the journal through the stream's processor facets on boot and exceeds
// the isolate's memory — on every wake, so the stream crash-loops until erased.

// Note that this test leaves a stream crash-looping so probably should avoid on prod.
// An acceptable cost in preview because we `pnpm erase-data` after every e2e run right now.
import { expect, test } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import type { Stream } from "../../src/itx-api.generated.ts";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

// Only against a deployed preview — it deliberately bricks a DO. SKIP (not
// fail) elsewhere, like the sibling e2e tests: a guard thrown inside the pin
// would not match the pinned failure and would read as an unrelated red.
const failReset = createFailing(
  test.skipIf(deployedBaseUrl() === null),
  /isolate exceeded its memory limit and was reset/i,
  { timeoutMs: 120_000 },
);

failReset("a stream survives being evicted after journaling oversized events", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`oversized-reset-${crypto.randomUUID().slice(0, 8)}`)
    .create({});
  await using stream = withTestReset(project.streams.get("/"));

  // Six events: four such events still boot (7.5s), six do not. 14MB, <<< 32MiB ceiling of Workers RPC
  const bigEvent = { type: "oversized-e2e/blob", payload: { blob: "x".repeat(14_000_000) } };
  for (let n = 0; n < 6; n++) {
    await stream.append(bigEvent).catch((error) => {
      if (!/event.* too large/i.test(String(error))) throw error;
    });
  }

  // .kill() aborts like a platform eviction (abort reported through the call and touches no storage.
  await expect(stream.kill(), "kill() reports its own abort").rejects.toThrow(/kill requested/);

  // Read a few times. Each read filtered to small wake events, so the cost is the boot, not the response.
  // A boot that dies replaying the journal throws the ooom+reset instead - a bad bug, at least on 2026-09-04.
  for (let read = 0; read < 3; read++) {
    const page = await stream.getEventPage({
      afterOffset: 0,
      limit: 500,
      eventTypes: ["events.iterate.com/stream/woken"],
    });
    expect(page.events, "the stream should wake twice: creation, then eviction").toHaveLength(2);
  }
});

// --- helpers ---

/**
 * The stream, plus a best-effort wipe on dispose (testReset: deleteAll + abort;
 * its "kill requested" rejection is the success). A stream that cannot boot cannot
 * be wiped — that is the pinned crash loop — so this logs and never throws: a throw
 * would bury the pinned failure in a SuppressedError.
 */
function withTestReset(stream: Stream): Stream & AsyncDisposable {
  const wipe = async () => {
    await (stream as unknown as { testReset(): Promise<void> })
      .testReset()
      .catch((error: unknown) => {
        if (/kill requested/i.test(String(error))) return;
        console.error("could not wipe stream - slot may crash-loop until erased:", error);
      });
  };
  // Wrapped rather than assigned onto: the stream is an RPC stub proxy.
  return new Proxy(stream, {
    get: (target, key, receiver) =>
      key === Symbol.asyncDispose ? wipe : Reflect.get(target, key, receiver),
  }) as Stream & AsyncDisposable;
}
