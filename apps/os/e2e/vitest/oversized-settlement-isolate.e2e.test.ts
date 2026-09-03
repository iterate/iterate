// The 2026-09-02 incident ("Durable Object's isolate exceeded its memory limit
// and was reset", crash-looping a stream), reproduced and A/B-tested on REAL
// deployed OS workers — real workerd, the real 128MiB isolate, the real
// chunk-blob StreamEventLog and settlement path. The node repro
// (src/domains/streams/oversized-settlement-crash.test.ts) proves the crash
// shape under a node heap proxy; this file proves it on the real engine.
//
// MEASURED 2026-09-03, by hand, preview_2 (no fix) vs preview_3 (fix):
//   - no fix, 3 of 3 attempts: four codemode scripts each returning ~14MB
//     journal their settlements verbatim and the stream DO dies on them. It
//     surfaces either as the run itself failing ("Internal error in Durable
//     Object storage caused object to be reset") or — when the settlement is
//     journaled by the NEXT incarnation and the run reports success — only as
//     a `stream/woken` reboot in the journal. One attempt went straight into
//     the incident's crash loop: a reboot every ~5s, each wake replaying the
//     oversized settlement and dying again.
//   - fix: the same four scripts settle at ~3KB each (`oversized.kind ===
//     "omitted"`), runScript rejects with "too large to retain", zero reboots.
//   - control, no fix: four tiny scripts, zero reboots — a `stream/woken`
//     between runs is a reboot, not per-request noise.
//
// Why ~14MB: a single result above ~32MB cannot cross the Workers RPC boundary
// at all ("Incoming message exceeds maximum size of 33554432 UTF-16 code
// units"), and ~7MB survives a handful of runs on a fresh stream — at that
// size the incident needed prod's accumulated history to tip.
//
// Both tests are pinned with failing(): green against a worker WITHOUT the fix,
// red WITH it — then delete the wrappers and keep the bodies as plain tests.
//
// Run against a preview (never shared/prod — it deliberately kills a DO):
//   doppler run --config preview_N -- pnpm --dir apps/os e2e --run oversized-settlement-isolate
//
// On a worker without the fix the second test would leave its stream
// crash-looping — the incident's other half, see tasks/stream-crash-quarantine.md
// (#2573) — so it wipes the stream's storage on the way out (see the disposer).
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

// The crash itself, on the real engine: the test above only proves the payload
// is unbounded; this one makes the isolate actually die. Four ~14MB runs on a
// no-fix worker took 110–135s by hand and in CI, hence the deadline — kept
// under the e2e policy's 240s per-test ceiling (E2E_HEAVY_TEST_TIMEOUT_MS):
// a hung test plus its one CI retry must finish before the preview run's
// 480s kill timer stops the whole vitest process.
const failReset = failing(test.skipIf(deployedBaseUrl() === null), /should not reset or reboot/i, {
  timeoutMs: 230_000,
});

failReset("the stream DO survives journaling oversized script results", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`oversized-reset-${crypto.randomUUID().slice(0, 8)}`)
    .create({});
  // Without the fix the stream is left crash-looping: every wake replays the
  // oversized settlement and dies again, burning DO duration until someone
  // erases the slot. Until test-created projects get a real teardown, wipe the
  // root stream's storage on the way out — a fresh empty stream has no poison
  // event to fold (verified by hand: the ~5s reboots stop). testReset aborts
  // the incarnation from inside the call, so its own "kill requested"
  // rejection is the success; a mid-reboot stream is retried. A wipe that
  // still fails is a real red, not the pin: it means a crash-looping DO was
  // left in the slot. Its throw wraps the pin's own failure in a
  // SuppressedError, so the reason is logged first where it can be found.
  await using _wipe = {
    [Symbol.asyncDispose]: async () => {
      const stream = project.streams.get("/") as unknown as { testReset(): Promise<void> };
      let failure = "";
      for (let attempt = 0; attempt < 6; attempt++) {
        failure = await stream.testReset().then(
          () => "",
          (error: unknown) => String(error),
        );
        if (/kill requested/i.test(failure) || failure === "") return;
      }
      const message = `could not wipe the stream after its oversized settlements - it may be crash-looping in this slot: ${failure}`;
      console.error(`[oversized-settlement] ${message}`);
      throw new Error(message);
    },
  };

  // Without the fix each ~14MB result is journaled verbatim and the DO dies on
  // it — sometimes as the run itself failing with a reset, sometimes only as a
  // reboot in the journal (the settlement is then journaled by the next
  // incarnation and the run reports success). With the fix every run rejects
  // with the bounded explanation instead, which is the fix and is swallowed.
  const resets: string[] = [];
  for (let run = 0; run < 4; run++) {
    await project.capabilityHost
      .runScript(`async () => ({ stdout: "iVBORw0KGgo".repeat(1_334_568) })`)
      .catch((error: unknown) => {
        if (/too large to retain/i.test(String(error))) return; // the fix
        resets.push(String(error));
      });
  }

  // Reboots show up in the journal as `stream/woken`: one when the stream is
  // created, and none between runs unless an incarnation died. Read only those
  // event types — a whole-window read of ~14MB settlements would itself be
  // enough to kill the DO again, which would be the pinned failure too.
  const timeline = await project.streams
    .get("/")
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
      resets.push(String(error));
      return [];
    });
  const firstRun = timeline.indexOf("capability-host/script-run-requested");
  const reboots = timeline.slice(firstRun).filter((type) => type === "stream/woken");

  expect(
    { resets, reboots },
    "the stream DO should not reset or reboot while journaling oversized script results",
  ).toEqual({ resets: [], reboots: [] });
});
