// The 2026-09-02 incident ("Durable Object's isolate exceeded its memory limit
// and was reset", crash-looping a stream for hours), reduced to its general
// mechanism and pinned on REAL deployed OS workers — real workerd, the real
// 128MiB isolate, the real chunk-blob StreamEventLog.
//
// The incident's poison event was a ~7MB codemode script result, but the
// settlement path is only how prod manufactured it. Any large events in a
// stream's journal do this: the incarnation that appends them survives, and
// the NEXT incarnation cannot boot — it replays the journal through the
// stream's processor facets, materializing every event, and exceeds the
// isolate's memory. Every platform retry boots into the same replay. A stream
// in that state cannot even be wiped: the wipe RPC needs an incarnation that
// boots. (src/domains/streams/oversized-settlement-crash.test.ts pins the same
// fold re-materialization under a node heap proxy, via the settlement path.)
//
// MEASURED 2026-09-04 on main (zod 4.5.4):
//   - six ~14MB events append fine, ~3s each, zero reboots
//   - kill() the incarnation (what a platform eviction does) and the next one
//     dies on any read — even a filtered read that returns nothing large —
//     with "Durable Object's isolate exceeded its memory limit and was reset",
//     on every wake, 3 of 3. Four such events still boot (7.5s); six do not.
//   - a whole-window read of the LIVE incarnation over six of them resets it
//     the same way; the read serializes them all before trimming
//   - wrangler tail (2026-09-03): the resets are outcome `exceededMemory` on
//     the stream DO and its ProcessorFacet only; 42 WebSocket-heavy bystander
//     tests on the same worker passed 42/42 — the blast radius is the
//     poisoned DO and its facets, not the isolate's other DOs
//
// Why ~14MB: a single value above 32MiB cannot cross Workers RPC (worker ↔ DO)
// or Cloudflare's inbound WebSocket frame ceiling at all; ~7MB needed prod's
// accumulated history to tip.
//
// Pinned with createFailing() on the reset's own message: the body asserts the
// desired behavior — a stream survives being evicted after journaling oversized
// events — catches nothing, and says nothing about how. Whatever the remedy, it
// has to hold for arbitrary appends, not just script settlements (#2572 bounds
// those; it would not flip this pin). When the body passes, delete the wrapper
// and keep it as a plain test.
//
// Run against a preview (never shared/prod — it deliberately bricks a DO):
//   doppler run --config preview_N -- pnpm --dir apps/os e2e --run oversized-settlement-isolate
// The test leaves its stream crash-looping; nothing test-side can clear that. The preview CI job (scripts/preview/preview.ts) runs erase-data on the
// slot after every e2e run (#2585); by hand, `pnpm run erase-data --env preview_N`. The platform-side answer is tasks/stream-crash-quarantine.md (#2573).
import { expect, test } from "vitest";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

// ~14MB of payload per event — see the header for why this size.
const OVERSIZED_EVENT = {
  type: "oversized-append-e2e/blob",
  payload: { blob: "x".repeat(14_000_000) },
};

// Only against a deployed preview — it deliberately bricks a DO. SKIP (not
// fail) elsewhere, like the sibling e2e tests: a guard thrown inside the pin
// would not match the pinned failure and would read as an unrelated red.
const failReset = createFailing(
  test.skipIf(deployedBaseUrl() === null),
  /isolate exceeded its memory limit and was reset|caused object to be reset/i,
  { timeoutMs: 120_000 },
);

failReset("a stream survives being evicted after journaling oversized events", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`oversized-reset-${crypto.randomUUID().slice(0, 8)}`)
    .create({});
  const stream = project.streams.get("/");
  // Best-effort wipe on the way out (deleteAll + abort, admin-only; its own
  // "kill requested" rejection is the success), for the day the body passes.
  // Today the stream cannot boot at all after this test, so the wipe cannot
  // land either: that is the crash loop, logged and left for the preview CI
  // job's post-run erase-data (#2585). Never thrown: it would wrap the pinned
  // failure in a SuppressedError the pin cannot match.
  await using _wipe = {
    [Symbol.asyncDispose]: async () => {
      await (stream as unknown as { testReset(): Promise<void> })
        .testReset()
        .catch((error: unknown) => {
          if (/kill requested/i.test(String(error))) return;
          console.error("could not wipe stream - slot may crash-loop until erased:", error);
        });
    },
  };

  // Six oversized events; the live incarnation survives journaling them.
  for (let n = 0; n < 6; n++) {
    await stream.append(OVERSIZED_EVENT).catch((error) => {
      if (!/event.* too large/i.test(String(error))) throw error;
    });
  }

  // .kill() aborts like a platform eviction (abort reported through the call and touches no storage.
  await expect(stream.kill(), "kill() reports its own abort").rejects.toThrow(/kill requested/);

  // Read a few times. Each read is filtered to the small events only, so what
  // it costs is the boot, not the response. A boot that dies replaying the
  // journal throws the reset instead — the pinned failure.
  for (let read = 0; read < 3; read++) {
    const page = await stream.getEventPage({
      afterOffset: 0,
      limit: 500,
      eventTypes: ["events.iterate.com/stream/woken"],
    });
    expect(page.events, "the stream should wake twice: creation, then eviction").toHaveLength(2);
  }
});
