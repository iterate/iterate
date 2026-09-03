// The 2026-09-02 incident ("Durable Object's isolate exceeded its memory limit
// and was reset", crash-looping a stream for hours), reproduced and A/B-tested
// on REAL deployed OS workers — real workerd, the real 128MiB isolate, the real
// chunk-blob StreamEventLog and settlement path. The node repro
// (src/domains/streams/oversized-settlement-crash.test.ts) proves the crash
// shape under a node heap proxy; this file proves it on the real engine.
//
// MEASURED 2026-09-04 on main after the zod 4.5.4 bump (#2561), which moved the
// write-side threshold — before it, four ~14MB settlements reset the DO while
// being journaled, 3 of 3; after it the journaling incarnation survives them:
//   - no fix: six codemode scripts each returning ~14MB journal fine, ~3s each,
//     zero reboots. Then the NEXT incarnation cannot boot: it replays the
//     journal through the processor facets and dies with "Durable Object's
//     isolate exceeded its memory limit and was reset" — on every wake, 3 of 3
//     — the incident's crash loop. A plain kill() (what a platform eviction
//     does) followed by the smallest filtered read is enough to show it; a
//     whole-window read of the live incarnation resets it the same way. Four
//     such settlements still boot (7.5s), six do not.
//   - fix: the same scripts settle at ~3KB each (`oversized.kind ===
//     "omitted"`), runScript rejects with "too large to retain", the eviction
//     is followed by a normal boot.
//   - wrangler tail during the pin (2026-09-03, pre-bump recipe): the resets
//     show as outcome `exceededMemory` on the stream DO and its ProcessorFacet
//     only; 42 WebSocket-heavy bystander tests on the same worker passed 42/42.
//     The blast radius is the poisoned DO and its facets, not the isolate's
//     other DOs.
//
// Why ~14MB: a single result above ~32MB cannot cross the Workers RPC boundary
// at all ("Incoming message exceeds maximum size of 33554432 UTF-16 code
// units"), and ~7MB needed prod's accumulated history to tip.
//
// Both tests are pinned with failing(): green against a worker WITHOUT the fix,
// red WITH it — then delete the wrappers and keep the bodies as plain tests.
//
// Run against a preview (never shared/prod — it deliberately bricks a DO):
//   doppler run --config preview_N -- pnpm --dir apps/os e2e --run oversized-settlement-isolate
//
// On a worker without the fix the second test leaves its stream crash-looping,
// and nothing test-side can clear that: the wipe RPC needs an incarnation that
// can boot. The preview CI job (scripts/preview/preview.ts) runs erase-data on
// the slot after every e2e run (#2585); by hand, `pnpm run erase-data --env preview_N`. The platform-side answer is
// tasks/stream-crash-quarantine.md (#2573).
import { expect, test } from "vitest";
import { failing } from "@iterate-com/shared/test-support/failing-test";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

// Only against a deployed preview — it deliberately stresses a DO. SKIP (not
// fail) elsewhere, like the sibling e2e tests: a guard thrown inside the pin
// would not match the pinned failure and would read as an unrelated red.
const failUnbounded = failing(test.skipIf(deployedBaseUrl() === null), /journaled unbounded/i, {
  timeoutMs: 90_000,
});

failUnbounded("an oversized script result is bounded before it is journaled", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`oversized-settlement-${crypto.randomUUID().slice(0, 8)}`)
    .create({});

  // Run the oversized script through the real product path. With the fix this
  // rejects with a bounded "too large to retain" explanation; without it, it
  // resolves with the whole ~7MB value.
  const returnedBytes = await project.capabilityHost
    .runScript(`async () => ({ stdout: "iVBORw0KGgo".repeat(660_000) })`)
    .then((settled) => JSON.stringify(settled.result ?? null).length)
    .catch((error: unknown) => {
      if (/too large to retain/i.test(String(error))) return 0; // bounded — the fix
      throw error;
    });

  const message = `an oversized script should not be journaled unbounded - this resets the stream DO isolate under the fold/delivery fan-out`;
  expect(returnedBytes, message).toBeLessThan(1_000_000);
});

// The reset's own spellings, all seen on real workerd. Only these count as the
// pinned failure; anything else — transport, auth, a hang — is rethrown so it
// cannot hold the pin.
const RESET = /caused object to be reset|exceeded its memory limit|went away/i;

// The crash itself, on the real engine: the test above only proves the payload
// is unbounded; this one makes the isolate actually die.
const failReset = failing(test.skipIf(deployedBaseUrl() === null), /should not reset or reboot/i, {
  timeoutMs: 120_000,
});

failReset("a stream survives being evicted after journaling oversized script results", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`oversized-reset-${crypto.randomUUID().slice(0, 8)}`)
    .create({});
  const stream = project.streams.get("/");
  // Best-effort wipe on the way out (deleteAll + abort, admin-only), so a
  // fixed worker — or a size that can still boot — leaves nothing behind.
  // testReset aborts the incarnation from inside the call, so its own "kill
  // requested" rejection is the success. Without the fix the stream cannot
  // boot at all after this test, so the wipe cannot land either: that is the
  // crash loop, logged and left for the preview CI job's post-run erase-data (#2585).
  await using _wipe = {
    [Symbol.asyncDispose]: async () => {
      const admin = stream as unknown as { testReset(): Promise<void> };
      let failure = "";
      for (let attempt = 0; attempt < 6; attempt++) {
        failure = await admin.testReset().then(
          () => "",
          (error: unknown) => String(error),
        );
        if (/kill requested/i.test(failure) || failure === "") return;
      }
      const message = `could not wipe the stream after its oversized settlements - it is crash-looping in this slot until the slot is erased: ${failure}`;
      console.error(`[oversized-settlement] ${message}`);
      if (RESET.test(failure)) return; // the pinned crash loop itself, not a test failure
      throw new Error(message);
    },
  };

  // Six ~14MB results. Without the fix they are journaled verbatim (the live
  // incarnation survives that on current main); with the fix every run
  // rejects with the bounded explanation, which is the fix and is swallowed.
  const resets: string[] = [];
  for (let run = 0; run < 6; run++) {
    await project.capabilityHost
      .runScript(`async () => ({ stdout: "iVBORw0KGgo".repeat(1_334_568) })`)
      .catch((error: unknown) => {
        if (/too large to retain/i.test(String(error))) return; // the fix
        if (!RESET.test(String(error))) throw error;
        resets.push(String(error));
      });
  }

  // Evict the incarnation the way the platform does — kill() aborts it and
  // touches no storage — then make the next one boot with the smallest
  // possible read. Reboots show up in the journal as `stream/woken`: exactly
  // one is expected here (this boot); a boot that dies replaying the journal
  // is the reset instead.
  await stream.kill().catch((error: unknown) => {
    if (!/kill requested/i.test(String(error))) throw error;
  });
  const timeline = await stream
    .getEventPage({
      afterOffset: 0,
      limit: 500,
      eventTypes: [
        "events.iterate.com/stream/woken",
        "events.iterate.com/capability-host/script-run-requested",
      ],
    })
    .then((page) => page.events.map((event) => event.type.replace("events.iterate.com/", "")))
    .catch((error: unknown): string[] => {
      if (!RESET.test(String(error))) throw error;
      resets.push(String(error));
      return [];
    });
  const firstRun = timeline.indexOf("capability-host/script-run-requested");
  const reboots = timeline.slice(firstRun).filter((type) => type === "stream/woken").length;

  expect(
    { resets, reboots },
    "the stream DO should not reset or reboot beyond the one eviction after journaling oversized script results",
  ).toEqual({ resets: [], reboots: 1 });
});
