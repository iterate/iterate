// The live-state channel over the real deployment transport. `.live.subscribe`
// pushes a full snapshot then minimal diffs; this exercises both cases the
// primitive supports — a Durable-Object-backed node (`itx.live`, whose demo
// counter is shared across watchers) and a stateless one (`itx.liveDemo.ticker`,
// driven by a timer in the request isolate with no DO).
import { expect, test } from "vitest";
import { applyPatch } from "../../src/lib/live-state/diff.ts";
import type { LiveUpdate } from "../../src/lib/live-state/protocol.ts";
import type { ProjectLiveState } from "../../src/domains/projects/project-live-state.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);

/** Reassemble a live subscription the way `useLiveState` does: snapshot, then patches. */
function trackLiveState<State>(): {
  onUpdate: (update: LiveUpdate<State>) => void;
  state: () => State | undefined;
  patchCount: () => number;
} {
  let state: State | undefined;
  let patches = 0;
  return {
    onUpdate: (update) => {
      if (update.type === "snapshot") state = update.state;
      else {
        patches += 1;
        state = applyPatch(state as State, update.patch);
      }
    },
    state: () => state,
    patchCount: () => patches,
  };
}

test("itx.live pushes a snapshot then a minimal diff; the DO-backed counter is shared", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({ slug: `live-state-${RUN_SUFFIX}-${marker}` });
  await project.__describe();

  const track = trackLiveState<ProjectLiveState>();
  using subscription = await project.live.subscribe(track.onUpdate);

  // The subscribe-time frame is a full snapshot: current state IS the first paint.
  await waitForCondition(() => track.state() !== undefined, {
    description: "the initial live snapshot",
  });
  expect(track.state()!.liveDemo).toMatchObject({ count: expect.any(Number) });
  const before = track.state()!.liveDemo.count;

  // Bumping the DO-backed counter arrives as a PATCH (not a re-snapshot) and only
  // moves the liveDemo slice — the processor's `reduced` slice is untouched.
  await project.liveDemo.increment();
  await waitForCondition(() => (track.state()?.liveDemo.count ?? before) > before, {
    description: "a patch reflecting the incremented counter",
    timeoutMs: 30_000,
  });
  expect(track.patchCount()).toBeGreaterThan(0);
  expect(track.state()!.liveDemo.count).toBe(before + 1);

  // ping() reports liveness — the lever the dashboard watchdog uses.
  expect(await subscription.ping()).toBe(true);
});

test("itx.liveDemo.ticker (stateless, no Durable Object) advances over time", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({ slug: `live-ticker-${RUN_SUFFIX}-${marker}` });
  await project.__describe();

  const track = trackLiveState<{ tick: number; startedAt: number }>();
  using subscription = await project.liveDemo.ticker.subscribe(track.onUpdate);

  await waitForCondition(() => (track.state()?.tick ?? 0) >= 2, {
    description: () => `the stateless ticker to reach tick >= 2 (at ${track.state()?.tick ?? 0})`,
    timeoutMs: 15_000,
  });
  expect(track.patchCount()).toBeGreaterThan(0); // it advanced via diffs, not re-snapshots
  expect(await subscription.ping()).toBe(true);
});
